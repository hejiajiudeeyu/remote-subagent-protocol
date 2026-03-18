import fs from "node:fs";
import path from "node:path";

import { ensureOpsDirectories, getOpsHomeDir } from "@delexec/runtime-utils";

function nowIso() {
  return new Date().toISOString();
}

export function getOpsLogsDir() {
  ensureOpsDirectories();
  return path.join(getOpsHomeDir(), "logs");
}

export function getServiceLogFile(service) {
  return path.join(getOpsLogsDir(), `${service}.log`);
}

export function getSupervisorEventsFile() {
  return path.join(getOpsLogsDir(), "supervisor.events.jsonl");
}

export function appendServiceLog(service, chunk) {
  fs.appendFileSync(getServiceLogFile(service), chunk, "utf8");
}

export function appendSupervisorEvent(event) {
  const record = {
    at: nowIso(),
    ...event
  };
  fs.appendFileSync(getSupervisorEventsFile(), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export function readLogTail(filePath, { maxLines = 200 } = {}) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

export function readServiceLogTail(service, options) {
  return readLogTail(getServiceLogFile(service), options);
}

export function readSupervisorEventTail(options) {
  return readLogTail(getSupervisorEventsFile(), options).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { at: null, type: "invalid_log_line", raw: line };
    }
  });
}
