import {
  afterEach,
  beforeEach,
  expect,
  onTestFinished,
  suite,
  test,
} from "vitest";

import { createServer } from "~/server";
import { tempScheduleStore } from "~/test/schedule";

type HealthCheck = { env: string; message: string; feedVersion: string | null };

suite("health/", () => {
  let fixture: Awaited<ReturnType<typeof tempScheduleStore>>;

  beforeEach(async () => {
    fixture = await tempScheduleStore();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function createApp() {
    const fastify = createServer(
      { logger: false },
      { scheduleStore: fixture.store },
    );
    onTestFinished(() => fastify.close());
    await fastify.ready();
    return fastify;
  }

  test("is unavailable until a Schedule is open", async () => {
    const fastify = await createApp();
    await fastify.scheduleLoader.refresh();

    const response = await fastify.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toEqual(503);
    expect(response.json<HealthCheck>()).toMatchObject({
      env: "test",
      feedVersion: null,
    });
  });

  test("is healthy once a Schedule is open", async () => {
    await fixture.publish("fv1");
    const fastify = await createApp();
    await fastify.scheduleLoader.refresh();

    const response = await fastify.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toEqual(200);
    expect(response.json<HealthCheck>()).toMatchObject({
      env: "test",
      message: "OK",
      feedVersion: "fv1",
    });
  });
});
