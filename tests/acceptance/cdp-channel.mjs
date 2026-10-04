/** Keep every CDP command bounded and reject outstanding work when Chrome disconnects. */
export function createCdpChannel(socket, timeoutMs = 5_000) {
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  const fail = () => {
    closed = true;
    for (const command of pending.values()) command.reject(new Error("Chrome debugging connection closed"));
    pending.clear();
  };
  const receive = (event) => {
    const message = JSON.parse(event.data);
    const command = pending.get(message.id);
    if (!command) return;
    pending.delete(message.id);
    message.error ? command.reject(new Error(message.error.message)) : command.resolve(message.result);
  };
  socket.addEventListener("message", receive);
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);

  return {
    send(method, params = {}) {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Chrome debugging connection closed"));
      }
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome command timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { pending.get(id)?.reject(error); pending.delete(id); }
      });
    },
    dispose() {
      fail();
      socket.removeEventListener("message", receive);
      socket.removeEventListener("close", fail);
      socket.removeEventListener("error", fail);
    },
  };
}
