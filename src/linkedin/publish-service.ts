/**
 * Compatibility type surface for callers that imported the former text-only
 * module. The unsafe model-authored publish implementation was removed; all
 * publishing now goes through the app-only approval capability state machine.
 */
export type {
  ImagePublishResult as PublishResult,
  ImagePublishService as PublishService,
  ImagePublishServiceDependencies as PublishServiceDependencies
} from "./image-publish-service.js";
