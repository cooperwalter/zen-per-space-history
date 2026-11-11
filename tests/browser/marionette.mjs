import net from "node:net";

export class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #waiting = new Map();
  #hello;
  #resolveHello;

  constructor(socket) {
    this.#socket = socket;
    this.#hello = new Promise((resolve) => {
      this.#resolveHello = resolve;
    });
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => {
      for (const { reject } of this.#waiting.values()) {
        reject(new Error("Marionette connection closed"));
      }
      this.#waiting.clear();
    });
    socket.on("error", () => {});
  }

  static async connect(port, { timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.connect({ host: "127.0.0.1", port });
          candidate.once("connect", () => resolve(candidate));
          candidate.once("error", reject);
        });
        const client = new Marionette(socket);
        await client.#hello;
        return client;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`Could not reach Marionette on port ${port}: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon === -1) {
        return;
      }
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) {
        return;
      }
      const message = JSON.parse(this.#buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.#resolveHello(message);
        continue;
      }
      const [, id, error, result] = message;
      const waiter = this.#waiting.get(id);
      if (!waiter) {
        continue;
      }
      this.#waiting.delete(id);
      if (error) {
        waiter.reject(new Error(`${error.error}: ${error.message}`));
      } else {
        waiter.resolve(result);
      }
    }
  }

  send(command, params = {}) {
    const id = this.#nextId++;
    const payload = Buffer.from(JSON.stringify([0, id, command, params]));
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#socket.write(Buffer.concat([Buffer.from(`${payload.length}:`), payload]));
    });
  }

  async start() {
    await this.send("WebDriver:NewSession", { capabilities: {} });
    await this.send("Marionette:SetContext", { value: "chrome" });
    await this.send("WebDriver:SetTimeouts", { script: 120000 });
  }

  async run(body, args = []) {
    const script = `
      const args = Array.from(arguments);
      const done = args.pop();
      (async () => { ${body} })().then(
        (value) => done({ ok: true, value: value === undefined ? null : value }),
        (error) => done({ ok: false, error: String(error), stack: error && error.stack })
      );`;
    const response = await this.send("WebDriver:ExecuteAsyncScript", {
      script,
      args,
      sandbox: "system",
      newSandbox: false,
    });
    const outcome = response.value;
    if (!outcome?.ok) {
      throw new Error(`Browser script failed: ${outcome?.error}\n${outcome?.stack ?? ""}`);
    }
    return outcome.value;
  }

  close() {
    this.#socket.destroy();
  }
}
