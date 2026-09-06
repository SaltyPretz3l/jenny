'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'plugins:view-bridge';
let sequence = 0;
const subscriptions = new Map();

function request(operation, payload = {}) {
  const requestId = `request_${Date.now().toString(36)}_${(sequence += 1).toString(36)}`;
  return ipcRenderer.invoke(CHANNEL, { method: 'request', request_id: requestId, operation, payload });
}

function subscribe(topic, listener) {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  const token = `subscription_${(sequence += 1).toString(36)}`;
  subscriptions.set(token, { topic, listener });
  void ipcRenderer.invoke(CHANNEL, { method: 'subscribe', request_id: token, topic });
  return () => {
    subscriptions.delete(token);
    void ipcRenderer.invoke(CHANNEL, { method: 'unsubscribe', request_id: token, topic });
  };
}

function cancel(requestId) {
  return ipcRenderer.invoke(CHANNEL, { method: 'cancel', request_id: String(requestId || '') });
}

ipcRenderer.on('plugins:view-event', (_event, message) => {
  let payload;
  try { payload = JSON.parse(message?.payload_json || 'null'); } catch (_error) { return; }
  for (const subscription of subscriptions.values()) {
    if (subscription.topic === message?.topic) subscription.listener(payload);
  }
});

contextBridge.exposeInMainWorld('jennyPlugin', Object.freeze({ request, subscribe, cancel }));
