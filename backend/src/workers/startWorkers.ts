import type { Server as SocketIOServer } from "socket.io";
import { anomalyWorkerTick } from "./anomalyWorker";
import { patternAbsenceWorkerTick } from "./patternAbsenceWorker";
import { escalationWorkerTick } from "./escalationWorker";

export function startWorkers(io: SocketIOServer) {
  // Fire immediately, then poll on an interval.
  void anomalyWorkerTick(io);
  void patternAbsenceWorkerTick(io);
  void escalationWorkerTick(io);

  // Rule A/B should process fast so alerts appear quickly.
  const anomalyEveryMs = 1000;
  const patternEveryMs = 5000; // silence detection <= 60s, and recovery within seconds
  const escalationEveryMs = 15000; // within 30s of 5-minute boundary

  setInterval(() => {
    void anomalyWorkerTick(io);
  }, anomalyEveryMs);

  setInterval(() => {
    void patternAbsenceWorkerTick(io);
  }, patternEveryMs);

  setInterval(() => {
    void escalationWorkerTick(io);
  }, escalationEveryMs);
}

