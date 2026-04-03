import { execSync } from "node:child_process";

const port = process.argv[2] ?? "3000";

function getPidsForPort(targetPort) {
  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${targetPort}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return [...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/).at(-1))
        .filter((pid) => pid && /^\d+$/.test(pid))
    )];
  } catch (error) {
    if (error.status === 1) {
      return [];
    }
    throw error;
  }
}

const pids = getPidsForPort(port);

if (pids.length === 0) {
  console.log(`No hay procesos escuchando en el puerto ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`Deteniendo PID ${pid} en el puerto ${port}...`);
  execSync(`taskkill /PID ${pid} /T /F`, { stdio: "inherit" });
}

console.log(`Puerto ${port} liberado.`);
