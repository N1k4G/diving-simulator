import {
  DEFAULT_PLANNER_SETTINGS,
  type PlannerForecast,
} from "../planner/dive-planner";
import { createInitialDiveState } from "../core/dive-state";
import "./diagnostic.css";
import { PlannerWorkerClient } from "./planner-worker-client";
import { renderWreckApplication } from "./wreck-app";

declare global {
  interface Window {
    plannerWorkerDiagnostic?: Promise<PlannerForecast>;
  }
}

/**
 * Round-trips one forecast through a throwaway planner worker.
 *
 * Development only. It exists to make a broken worker boundary loud at start-up
 * rather than at the first forecast, and it is deliberately absent from
 * production builds: it spawns a second worker on every load, and the
 * Definition of done requires diagnostics to be absent from production. The
 * shipped path proves the same boundary by using it — see
 * tests/planner-worker.spec.js, which drives the worker the running simulation
 * creates instead of this one.
 */
export async function verifyPlannerWorker(
  client = new PlannerWorkerClient(),
): Promise<PlannerForecast> {
  try {
    return await client.forecast(
      createInitialDiveState(0),
      DEFAULT_PLANNER_SETTINGS,
    );
  } finally {
    client.dispose();
  }
}

if (typeof document !== "undefined") {
  const root = document.querySelector<HTMLElement>("#app");

  if (!root) {
    throw new Error("Bootstrap root #app was not found");
  }

  renderWreckApplication(root);

  if (import.meta.env.DEV) {
    window.plannerWorkerDiagnostic = verifyPlannerWorker();
    void window.plannerWorkerDiagnostic.catch((error: unknown) => {
      console.error(error);
    });
  }
}
