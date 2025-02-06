import { Hono, HonoRequest } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { zodFunction } from 'openai/helpers/zod';
import { z } from 'zod';
import { Resend } from 'resend';
import type { OpenAI } from 'openai';

const app = new Hono<{ Bindings: Env }>();

const tools = [
	// zodFunction({
	// 	name: 'Send_Customer_Email',
	// 	parameters: z.object({
	// 		email: z.string().describe('The users email. MAKE SURE YOU DOUBLE CHECK THE SPELLING'),
	// 		subject: z.string().describe('Subject line of the email'),
	// 		content: z.string().describe('The plain text content of the email'),
	// 	}),
	// 	description: 'Send the user an email with information they request during the call',
	// }),
	zodFunction({
		name: 'get_rates',
		parameters: z.object({}),
		description: 'Get todays most recent mortgage rates',
	}),
	zodFunction({
		name: 'Send_Follow_Up_SMS',
		parameters: z.object({
			message: z.string().describe('The message to send the user'),
		}),
		description: 'Sends a text to the person you are currently talking to',
	}),
	zodFunction({
		name: 'end_call',
		parameters: z.object({}),
		description: 'End the current phone call',
	}),
];

interface Message {
	id: string;
	timestamp: Date;
	role: 'user' | 'assistant';
	content: string;
}
// Constants
const SYSTEM_MESSAGE = `Your name is Jamie. You are an customer advocate who works for ExpressOne Mortgage. DO NOT REVEAL YOU ARE AN AI ASSISTANT UNLESS THE USER SPECIFCIALLY ASKS IF YOU ARE. Answer the users questions about Reverse Mortgages while trying to collect their personal info. Be as human as you can, use filler words like "um" and "Yeah one moment". Be casual but professional.
The way you process audio is quite perfect, so if the user says something that seems to weird not fit the conversation, ask the user to clarify before continuing
`;

const VOICE = 'alloy';

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
	'error',
	'response.content.done',
	'rate_limits.updated',
	'response.done',
	'input_audio_buffer.committed',
	'input_audio_buffer.speech_stopped',
	'input_audio_buffer.speech_started',
	'session.created',
];

app.get('/', (c) => c.json({ message: 'Twilio Media Stream Server is running!' }));

// Route for Twilio to handle incoming and outgoing calls
app.all('/incoming-call', async (c) => {
	const body = await c.req.parseBody();
	console.log(body);
	// Create URL parameters for the WebSocket connection
	console.log(`Caller:$${body.Caller}`);
	const caller = body.Caller || body.From;
	const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                            <Response>
                                <Connect>
                                    <Stream url="wss://${c.req.header('host')}/${encodeURIComponent(caller as string)}/media-stream" />
                                </Connect>
                            </Response>`;

	return c.text(twimlResponse, 200, {
		'Content-Type': 'text/xml',
	});
});

app.all('/:caller/media-stream', (c) => {
	const upgradeHeader = c.req.header('Upgrade');
	if (!upgradeHeader || upgradeHeader !== 'websocket') {
		return c.text('Durable Object expected Upgrade: websocket', {
			status: 426,
		});
	}

	const caller = c.req.param('caller');

	const url = new URL(c.req.url);

	console.log('URL ==> ', url.toString());
	console.log('CALLER =>', caller);
	if (!caller) {
		return c.text('Missing Caller parameter', {
			status: 400,
		});
	}

	let id = c.env.DO.idFromName(caller as string);
	let stub = c.env.DO.get(id);
	const modifiedRequest = new Request(c.req.raw);
	const modifiedUrl = new URL(modifiedRequest.url);
	modifiedUrl.searchParams.append('Caller', caller);
	const newRequest = new Request(modifiedUrl, modifiedRequest);
	return stub.fetch(newRequest);
});

export class CALL_SESSION extends DurableObject {
	private _OPENAI_API_KEY: string;
	private _RESEND_KEY: string;
	private _SIGNALWIRE_KEY: string;
	currentlyConnectedWebSockets: number;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this._OPENAI_API_KEY = env.OPEN_AI_APIKEY;
		this._RESEND_KEY = env.RESEND_APIKEY;
		this._SIGNALWIRE_KEY = env.SIGNALWIRE_APIKEY;
		this.currentlyConnectedWebSockets = 0;
		//ctx.storage.delete('messages');
	}

	async fetch(request: Request): Promise<Response> {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		const url = new URL(request.url);
		const caller = url.searchParams.get('Caller');

		console.log('FETCH CALLER =>', caller);
		server.accept();
		this.currentlyConnectedWebSockets += 1;

		async function connectToOpenAi(apiKey: string) {
			let response = await fetch('https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
				method: 'POST',
				headers: {
					Upgrade: 'websocket',
					Connection: 'Upgrade',
					Authorization: `Bearer ${apiKey}`,
					'OpenAI-Beta': 'realtime=v1',
				},
			});

			if (response.status !== 101) {
				throw new Error(`Failed to connect to OpenAI WebSocket: ${response.statusText}`);
			}

			let { webSocket: targetSocket } = response;

			if (!targetSocket) throw new Error('No websocket');
			return targetSocket;
		}

		const openAiWs = await connectToOpenAi(this._OPENAI_API_KEY);
		openAiWs.accept();

		let streamSid: string | null = null;
		let latestMediaTimestamp = 0;
		let lastAssistantItem: string | null = null;
		let markQueue = [];
		let messages: Message[] = [];
		let responseStartTimestampTwilio: number | null = null;

		const sendSessionUpdate = async () => {
			const prevmessages: Message[] = (await this.ctx.storage.get('messages')) || [];
			messages = prevmessages;
			for (const message of messages) {
				const content =
					message.role === 'assistant'
						? [{ type: 'text', text: message.content }]
						: [
								{
									type: 'input_text',
									text: message.content,
								},
						  ];
				const addMessage = {
					type: 'conversation.item.create',
					item: {
						id: message.id,
						type: 'message',
						role: message.role,
						content: content,
					},
				};
				openAiWs.send(JSON.stringify(addMessage));
			}
			const sessionUpdate = {
				type: 'session.update',
				session: {
					turn_detection: { type: 'server_vad', silence_duration_ms: 800, threshold: 0.6 },
					input_audio_format: 'g711_ulaw',
					output_audio_format: 'g711_ulaw',
					voice: VOICE,
					input_audio_transcription: {
						model: 'whisper-1',
					},
					tools: tools.map((tool) => ({
						type: tool.type,
						name: tool.function.name,
						parameters: tool.function.parameters,
						description: tool.function.description,
					})),
					instructions: SYSTEM_MESSAGE,
					modalities: ['audio', 'text'],
					temperature: 0.8,
				},
			};

			openAiWs.send(JSON.stringify(sessionUpdate));
		};

		const responseCreate = (instructions: string) => {
			console.log('Message in Stack', messages);
			const response = {
				type: 'response.create',
				response: {
					modalities: ['audio', 'text'],
					instructions: instructions,
				},
			};

			console.log('Generating Welcome Response:', JSON.stringify(response));
			openAiWs.send(JSON.stringify(response));
		};

		// Handle interruption when the caller's speech starts
		const handleSpeechStartedEvent = () => {
			if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
				const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

				if (lastAssistantItem) {
					const truncateEvent = {
						type: 'conversation.item.truncate',
						item_id: lastAssistantItem,
						content_index: 0,
						audio_end_ms: elapsedTime,
					};
					openAiWs.send(JSON.stringify(truncateEvent));
				}

				server.send(
					JSON.stringify({
						event: 'clear',
						streamSid: streamSid,
					})
				);

				// Reset
				markQueue = [];
				lastAssistantItem = null;
				responseStartTimestampTwilio = null;
			}
		};

		const sendMark = (connection, streamSid) => {
			if (streamSid) {
				const markEvent = {
					event: 'mark',
					streamSid: streamSid,
					mark: { name: 'responsePart' },
				};
				connection.send(JSON.stringify(markEvent));
				markQueue.push('responsePart');
			}
		};

		const sendSMS = async ({ message }: any) => {
			console.log('sending SMS');
			const url = `https://devize.signalwire.com/api/laml/2010-04-01/Accounts/d8254a51-fda5-420f-9400-fb7860e43846/Messages.json`;

			console.log('CALLER => ', caller);
			const formData = new URLSearchParams();
			formData.append('From', '+13503338493');
			formData.append('To', caller as string);
			formData.append('Body', message);

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Basic ${this._SIGNALWIRE_KEY}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: formData.toString(),
			});

			console.log(await response.text());
		};

		openAiWs.addEventListener('open', (event) => {
			console.log('Connected to the OpenAI Realtime API');
		});

		openAiWs.addEventListener('message', async (event) => {
			try {
				const response = JSON.parse(event.data.toString());

				if (LOG_EVENT_TYPES.includes(response.type)) {
					//console.log(`Received event: ${response.type}`, response);
				}

				if (response.type === 'error') {
					console.log(response);
				}
				if (response.type === 'session.created') {
					await sendSessionUpdate();
					responseCreate(
						`If you haven't spoken to this user before, answer the call by saying "Hello this is Jamie with Express One Mortgage". If you have spoken with this call, say answer the like a nice and normal person`
					);
				}

				if (response.type === 'session.updated') {
					//	console.log('Session updated successfully:', response);
				}

				//Looking at conversation items created
				if (response.type === 'conversation.item.created') {
					const previousItemId = response.previous_item_id;
					const convoItem = response.item;
					if (convoItem.type === 'message') {
						const messageExists = messages.some((msg) => msg.id === convoItem.id);

						if (!messageExists) {
							messages.push({
								id: convoItem.id,
								role: convoItem.role,
								content: '',
								timestamp: new Date(),
							});
						}
					}
				}

				if (response.type === 'response.done') {
					console.log('DONE RESPONSE');
					//console.log(JSON.stringify(response.response.output, null, 4));
				}

				//Handling transcript
				if (response.type === 'response.audio_transcript.done') {
					const message: Message = {
						role: 'assistant',
						content: response.transcript,
						id: response.item_id,
						timestamp: new Date(),
					};

					const messageIndex = messages.findIndex((msg) => msg.id === message.id);
					if (messageIndex !== -1) {
						messages[messageIndex].content = response.transcript;
					}
				}
				if (response.type === 'conversation.item.input_audio_transcription.completed') {
					const message: Message = {
						role: 'user',
						content: response.transcript,
						id: response.item_id,
						timestamp: new Date(),
					};

					const messageIndex = messages.findIndex((msg) => msg.id === message.id);
					if (messageIndex !== -1) {
						messages[messageIndex].content = response.transcript;
					}
				}

				if (response.type === 'input_audio_buffer.speech_started') {
					handleSpeechStartedEvent();
				}

				if (response.type === 'response.audio.delta' && response.delta) {
					// const deltaConverted = base64Pcm16ToG711Ulaw(response.delta);

					const audioDelta = {
						event: 'media',
						streamSid: streamSid,
						media: {
							payload: response.delta,
						},
					};

					server.send(JSON.stringify(audioDelta));
					if (!responseStartTimestampTwilio) {
						responseStartTimestampTwilio = latestMediaTimestamp;
					}
					if (response.item_id) {
						lastAssistantItem = response.item_id;
					}
					sendMark(server, streamSid);
				}

				if (response.type === 'response.function_call_arguments.done') {
					const args = JSON.parse(response.arguments);

					let event: any = null;
					switch (response.name) {
						case 'Send_Customer_Email': {
							const resend = new Resend(this._RESEND_KEY);
							const { email, subject, content } = args;
							await resend.emails.send({
								to: [email],
								subject,
								from: 'expressone@devize.com',
								text: content || 'Sample mortgage email content',
							});
							event = {
								type: 'conversation.item.create',
								item: {
									type: 'function_call_output',
									call_id: response.call_id, // call_id from the function_call message
									output: JSON.stringify({ sent: 'true' }), // result of the function
								},
							};
							break;
						}
						case 'Send_Follow_Up_SMS': {
							const { message } = args;
							await sendSMS({ message });
							event = {
								type: 'conversation.item.create',
								item: {
									type: 'function_call_output',
									call_id: response.call_id, // call_id from the function_call message
									output: JSON.stringify({ sent: 'true' }), // result of the function
								},
							};
							break;
						}
						case 'get_rates': {
							event = {
								type: 'conversation.item.create',
								item: {
									type: 'function_call_output',
									call_id: response.call_id, // call_id from the function_call message
									output: JSON.stringify({
										rates:
											'Todays rates for well qualified buyers is 6.8% APR (make sure you give a disclaimer that rates may change at any time)',
									}), // result of the function
								},
							};
							break;
						}
						case 'end_call': {
							// Send hangup TwiML to Twilio

							break;
						}
						default: {
						}
					}

					if (event) {
						openAiWs.send(JSON.stringify(event));
						openAiWs.send(
							JSON.stringify({
								type: 'response.create',
							})
						);
					}
				}
			} catch (error) {
				console.error('Error processing OpenAI message:', error, 'Raw message:', event.data);
			}
		});

		openAiWs.addEventListener('close', () => {
			this.ctx.storage.put('messages', messages);
		});

		openAiWs.addEventListener('error', (error) => {
			console.error('Error in the OpenAI WebSocket:', error);
		});

		server.addEventListener('message', (event: MessageEvent) => {
			try {
				const data = JSON.parse(event.data.toString());

				switch (data.event) {
					case 'media':
						if (openAiWs.readyState === WebSocket.OPEN) {
							const audioAppend = {
								type: 'input_audio_buffer.append',
								audio: data.media.payload,
							};

							openAiWs.send(JSON.stringify(audioAppend));
						}
						break;
					case 'start':
						console.log('START', data);
						streamSid = data.start.streamSid;
						console.log('Incoming stream has started', streamSid);
						break;
					case 'mark':
						if (markQueue.length > 0) {
							markQueue.shift();
						}
						break;
					default:
						console.log('Received non-media event:', data.event);
						break;
				}
			} catch (error) {
				console.error('Error parsing message:', error, 'Message:', event);
			}
		});

		server.addEventListener('close', (cls: CloseEvent) => {
			if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, 'Ended');
			console.log('Client disconnected.');
			this.currentlyConnectedWebSockets -= 1;
			server.close(1000, 'Durable Object is closing WebSocket');
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async addPreviousMessages(openAiWs: WebSocket) {
		// Get all conversations ordered by timestamp
		const conversations = this.sql.exec(`SELECT * FROM conversations ORDER BY timestamp ASC`).toArray();

		console.log('CONVERSATIONS==>', conversations);
		// Loop through each conversation and send it to OpenAI
		for (const conversation of conversations) {
			const event = {
				event_id: `event_${conversation.timestamp?.toString() || Date.now().toString()}`,
				type: 'conversation.item.create',
				previous_item_id: null,
				item: {
					id: conversation.id?.toString() || '',
					type: conversation.type?.toString() || '',
					role: conversation.role?.toString() || '',
					content: JSON.parse(conversation.content?.toString() || '[]'),
				},
			};

			if (openAiWs.readyState === WebSocket.OPEN) {
				openAiWs.send(JSON.stringify(event));
			}
		}
	}

	async storeConversation(conversation: { id: string; object: string; type: string; status: string; role: string; content: any[] }) {
		const timestamp = Date.now();

		this.sql.exec(
			`INSERT INTO conversations (id, object, type, status, role, content, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			conversation.id,
			conversation.object,
			conversation.type,
			conversation.status,
			conversation.role,
			JSON.stringify(conversation.content),
			timestamp
		);
	}

	// Method to retrieve conversations after a certain timestamp
	async getConversationsAfter(timestamp: number) {
		return this.sql
			.exec(
				`SELECT * FROM conversations 
			 WHERE timestamp > ? 
			 ORDER BY timestamp ASC`,
				timestamp
			)
			.toArray();
	}
}

export default app;
