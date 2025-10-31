/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

jest.mock("../../../utils/hibp", () => {
  return {
    fetchHibpBreaches: jest.fn(), // overwrite in tests
  };
});

import * as HIBP from "../../../utils/hibp";
import { logger } from "../../../app/functions/server/logging";
import { RemoteSettingsClient } from "../../../utils/remoteSettingsClient";
import { validateConfig, main } from "./updateBreachesInRemoteSettings";
import HibpData from "../../../test/seeds/hibpBreachResponse.json";
import * as Sentry from "@sentry/node";

// These can't be run because of jsdom environment and interaction
// with logger.
// I tried to mock the logger, but I couldn't mock the event handler
// because setImmediate isn't in jsdom
// And I can't run this in jest node environment because then the
// current jest setup fails.
// I don't know if these tests work, but when we refactor to run
// node tests in the appropriate environment they can be revisited.
// For now I'm relying on manual testing via dev environment.
// TODO: [MNTOR-1880]
describe("updateBreachesInRemoteSettings job", () => {
  const originalEnv = { ...process.env };

  const fetchBreachesSpy = jest.spyOn(
    RemoteSettingsClient.prototype,
    "fetchRemoteBreachNames",
  );
  const addBreachSpy = jest.spyOn(
    RemoteSettingsClient.prototype,
    "addNewBreach",
  );
  const reviewSpy = jest.spyOn(
    RemoteSettingsClient.prototype,
    "requestBreachesReview",
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
    process.env = { ...originalEnv };

    process.env.FX_REMOTE_SETTINGS_WRITER_USER = "user";
    process.env.FX_REMOTE_SETTINGS_WRITER_PASS = "pass";
    process.env.FX_REMOTE_SETTINGS_WRITER_SERVER = "https://example.com/v1";
    process.env.APP_ENV = "local";
  });
  afterAll(() => {
    process.env = originalEnv;
  });
  describe("validation", () => {
    it("throws if environment variables are missing", () => {
      delete process.env.FX_REMOTE_SETTINGS_WRITER_USER;
      delete process.env.FX_REMOTE_SETTINGS_WRITER_PASS;
      delete process.env.FX_REMOTE_SETTINGS_WRITER_SERVER;

      expect(() => validateConfig()).toThrow(
        /requires FX_REMOTE_SETTINGS_WRITER_SERVER/i,
      );
    });
    it("returns the config when all required env vars present", () => {
      const config = validateConfig();
      expect(config).toEqual({
        user: "user",
        password: "pass",
        server: "https://example.com/v1",
        breachesPath: "/buckets/main-workspace/collections/fxmonitor-breaches",
      });
    });
  });
  describe.skip("shutdown handling", () => {
    const endSpy = jest.spyOn(logger, "end");
    const sentrySpy = jest.spyOn(Sentry, "isInitialized").mockReturnValue(true);
    const sentryFlushSpy = jest.spyOn(Sentry, "flush").mockResolvedValue(true);
    afterAll(() => {
      endSpy.mockRestore();
      sentrySpy.mockRestore();
      sentryFlushSpy.mockRestore();
    });
    it("Ensures logs are sent and flushes Sentry prior to exiting", async () => {
      const fetchMock = HIBP.fetchHibpBreaches as jest.MockedFunction<
        typeof HIBP.fetchHibpBreaches
      >;
      fetchMock.mockResolvedValue([]);
      fetchBreachesSpy.mockResolvedValueOnce(new Set([]));
      await main(logger);
      expect(endSpy).toHaveBeenCalled();
      expect(sentrySpy).toHaveBeenCalled();
      expect(sentryFlushSpy).toHaveBeenCalled();
    });
  });
  describe.skip("main job", () => {
    it("skips review request if all posts failed", async () => {
      const breach = HibpData[0] as HIBP.HibpGetBreachesResponse[number];
      const fetchMock = HIBP.fetchHibpBreaches as jest.MockedFunction<
        typeof HIBP.fetchHibpBreaches
      >;
      fetchMock.mockResolvedValue([breach]);
      fetchBreachesSpy.mockResolvedValueOnce(new Set([]));
      addBreachSpy.mockRejectedValueOnce(new Error("Nope"));
      await main(logger);
      expect(reviewSpy).not.toHaveBeenCalled();
    });
    it("skips review request if nothing new was posted", async () => {
      const breach = HibpData[0] as HIBP.HibpGetBreachesResponse[number];
      const fetchMock = HIBP.fetchHibpBreaches as jest.MockedFunction<
        typeof HIBP.fetchHibpBreaches
      >;
      fetchMock.mockResolvedValue([breach]);
      fetchBreachesSpy.mockResolvedValueOnce(new Set([breach.Name]));
      await main(logger);
      expect(reviewSpy).not.toHaveBeenCalled();
    });
    it("happy path: logs counts, posts filtered breaches, requests review, and exits", async () => {
      const breaches = HibpData.slice(2) as HIBP.HibpGetBreachesResponse;
      const fetchMock = HIBP.fetchHibpBreaches as jest.MockedFunction<
        typeof HIBP.fetchHibpBreaches
      >;
      fetchMock.mockResolvedValue(breaches);
      fetchBreachesSpy.mockResolvedValueOnce(new Set([]));
      addBreachSpy.mockResolvedValue(undefined);
      reviewSpy.mockResolvedValue(undefined);

      await main(logger);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(addBreachSpy).toHaveBeenCalledTimes(2);
      expect(reviewSpy).toHaveBeenCalledTimes(1);
    });
    it("happy path: exits with code 1 if review fails", async () => {
      const breaches = HibpData.slice(2) as HIBP.HibpGetBreachesResponse;
      const fetchMock = HIBP.fetchHibpBreaches as jest.MockedFunction<
        typeof HIBP.fetchHibpBreaches
      >;
      fetchMock.mockResolvedValue(breaches);
      fetchBreachesSpy.mockResolvedValueOnce(new Set([]));
      addBreachSpy.mockResolvedValue(undefined);
      reviewSpy.mockRejectedValueOnce(new Error("Nope"));

      // Probably undefined
      const prevExitCode = process.exitCode;
      delete process.exitCode;

      await main(logger);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(addBreachSpy).toHaveBeenCalledTimes(2);
      expect(reviewSpy).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toEqual(1);

      process.exitCode = prevExitCode;
    });
  });
});
