import { createServer } from "node:http";
import { connect, type ChannelModel, type ConsumeMessage } from "amqplib";
import { ConsumerState, type Delivered } from "./state.js";

// AMQP_URL and QUEUE_NAME are injected by plugbricks from the queue provider (examples/rabbitmq).
// The URL holds a password: never log it.
function required(name: "AMQP_URL" | "QUEUE_NAME"): string {
  const value = process.env[name];
  if (!value) {
    console.error(`queue-consumer: ${name} is not set; it is injected when the brick requires queue`);
    process.exit(1);
  }
  return value;
}

const url = required("AMQP_URL");
const queue = required("QUEUE_NAME");
const port = Number(process.env.PORT ?? 4000);
const state = new ConsumerState();
let connection: ChannelModel | undefined;
let running = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects, declares the queue, publishes one message and consumes it. Stays connected; when the
 * connection closes, it retries. The round-trip is what /health reports: a real message through the
 * broker with this consumer's own credentials and vhost.
 */
async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      try {
        const model = await connect(url);
        connection = model;
        state.markConnected();
        model.on("close", () => {
          state.markDisconnected();
          console.error("queue-consumer: connection closed; reconnecting");
          setTimeout(() => void run(), 2_000);
        });
        model.on("error", (e: Error) => {
          state.markDisconnected();
          console.error(`queue-consumer: connection error: ${e.message}`);
        });
        const channel = await model.createChannel();
        await channel.assertQueue(queue, { durable: true });
        const message: Delivered = { from: queue, at: new Date().toISOString() };
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true });
        await new Promise<void>((resolve) => {
          void channel.consume(queue, (msg: ConsumeMessage | null) => {
            if (!msg) return;
            channel.ack(msg);
            try {
              const body = JSON.parse(msg.content.toString()) as Partial<Delivered>;
              state.markDelivered({ from: String(body.from ?? ""), at: String(body.at ?? "") });
            } catch {
              state.markDelivered({ from: queue, at: "" });
            }
            resolve();
          });
        });
        console.log(`queue-consumer: queue "${queue}" ready, message published and consumed`);
        return;
      } catch (e) {
        state.markDisconnected();
        console.error(`queue-consumer: not connected yet: ${(e as Error).message}`);
        await sleep(2_000);
      }
    }
  } finally {
    running = false;
  }
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(state.healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(`${JSON.stringify({ ok: state.healthy, queue, ...state.body })}\n`);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
});
server.listen(port, () => console.log(`queue-consumer: listening on :${port} (/health)`));

void run();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      void connection?.close().finally(() => process.exit(0));
    });
  });
}
