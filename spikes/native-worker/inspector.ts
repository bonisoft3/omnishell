import WebSocket from 'npm:ws@8.18.3';

export async function inspect(inspector: string) {
	const targets = await (await fetch(inspector + '/json')).json();
	const socket = new WebSocket(targets[0].webSocketDebuggerUrl, {
		origin: 'http://localhost:20219',
	});
	await new Promise((resolve, reject) => {
		socket.once('open', resolve);
		socket.once('error', reject);
	});
	let id = 0;
	const pending = new Map();
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (!message.id) return;
		const callbacks = pending.get(message.id);
		if (!callbacks) return;
		clearTimeout(callbacks.timer);
		pending.delete(message.id);
		if (message.error) {
			callbacks.reject(new Error(JSON.stringify(message.error)));
		} else callbacks.resolve(message.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const key = ++id;
			const timer = setTimeout(() => {
				pending.delete(key);
				reject(new Error(`inspector timed out: ${method}`));
			}, 10000);
			pending.set(key, { resolve, reject, timer });
			socket.send(JSON.stringify({ id: key, method, params }));
		});
	return { send, close: () => socket.terminate() };
}
