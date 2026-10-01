import { writeFileSync } from "node:fs";
import { extractTunnelUrl, webhookUrl } from "./extractTunnelUrl.js";

export interface RunTunnelOptions {
  /** The tunnel command, e.g. ["cloudflared", "tunnel", "--url", "http://localhost:3000"]. */
  cmd: string[];
  /** Where to write the webhook URL (overwriting any existing file) once the tunnel URL appears in the output. */
  file: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Called with the webhook URL right after the file has been written. */
  onUrl?: (webhookUrl: string) => void;
}

// Enough tail from the previous chunk to catch a URL split across two reads.
const TAIL_CHARS = 200;

/**
 * Runs the tunnel command, passes its stdout and stderr through unchanged, and writes
 * `<tunnel url>/webhooks/github` to `file` the first time a tunnel URL shows up in either stream.
 * The file is left in place when the command exits. Resolves with the command's exit code.
 */
export async function runTunnel(options: RunTunnelOptions): Promise<number> {
  const { cmd, file, onUrl } = options;
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));

  const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });

  // Ctrl+C reaches both this process and the child; wait for the child to exit rather than dying first.
  const stop = () => proc.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let found = false;
  const watch = (tail: { text: string }, chunk: string) => {
    if (found) return;
    const url = extractTunnelUrl(tail.text + chunk);
    if (url) {
      found = true;
      const hook = webhookUrl(url);
      writeFileSync(file, hook);
      onUrl?.(hook);
    } else {
      tail.text = (tail.text + chunk).slice(-TAIL_CHARS);
    }
  };

  const pump = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    const decoder = new TextDecoder();
    const tail = { text: "" };
    for await (const bytes of stream) {
      const chunk = decoder.decode(bytes, { stream: true });
      sink(chunk);
      watch(tail, chunk);
    }
  };

  try {
    const [exitCode] = await Promise.all([proc.exited, pump(proc.stdout, writeOut), pump(proc.stderr, writeErr)]);
    return exitCode;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
