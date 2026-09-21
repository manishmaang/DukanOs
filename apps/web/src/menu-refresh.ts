export function notifyMenuChanged() {
  window.dispatchEvent(new Event('dukanos-menu-changed'));
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel('dukanos-menu');
    channel.postMessage('changed');
    channel.close();
  }
}
