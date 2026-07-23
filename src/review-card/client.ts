import {
  createReviewCardController,
  type PublishConfirmation,
  type PublishTerminalView,
  type ReviewCardGlobalSource,
  type ReviewCardGlobals,
  type ReviewCardUi,
  type ReviewCardView
} from "./controller.js";

type OpenAiBridge = Readonly<{
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
}>;

declare global {
  interface Window {
    openai?: OpenAiBridge;
  }
}

function getToolResponseMetadata(): unknown {
  return window.openai?.toolResponseMetadata;
}

function globalsSnapshot(): ReviewCardGlobals {
  const bridge = window.openai;
  if (bridge === undefined) return {};
  return {
    ...(bridge.toolOutput === undefined ? {} : { toolOutput: bridge.toolOutput }),
    ...(getToolResponseMetadata() === undefined ? {} : { toolResponseMetadata: getToolResponseMetadata() })
  };
}

const globals: ReviewCardGlobalSource = {
  snapshot: globalsSnapshot,
  subscribe(listener) {
    const handleGlobals = () => listener();
    window.addEventListener("openai:set_globals", handleGlobals, { passive: true });
    return () => window.removeEventListener("openai:set_globals", handleGlobals);
  }
};

function element<T extends HTMLElement>(id: string, constructor: { new(): T }): T | undefined {
  const value = document.getElementById(id);
  return value instanceof constructor ? value : undefined;
}

function abbreviatedChecksum(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function bootstrap(): void {
  const reviewRoot = element("review-root", HTMLElement);
  const postText = element("post-text", HTMLElement);
  const postVisibility = element("post-visibility", HTMLElement);
  const postMedia = element("post-media", HTMLOListElement);
  const postId = element("post-id", HTMLElement);
  const postVersion = element("post-version", HTMLElement);
  const postChecksum = element("post-checksum", HTMLElement);
  const previewExpiry = element("preview-expiry", HTMLElement);
  const brandProvenance = element("brand-provenance", HTMLElement);
  const brandSeries = element("brand-series", HTMLElement);
  const brandProfileVersion = element("brand-profile-version", HTMLElement);
  const brandTemplate = element("brand-template", HTMLElement);
  const brandHook = element("brand-hook", HTMLElement);
  const brandChecksum = element("brand-checksum", HTMLElement);
  const brandValidation = element("brand-validation", HTMLElement);
  const validationStatus = element("validation-status", HTMLElement);
  const validationErrors = element("validation-errors", HTMLUListElement);
  const createPreviewButton = element("create-preview", HTMLButtonElement);
  const publishButton = element("publish-post", HTMLButtonElement);
  const confirmation = element("publish-confirmation", HTMLDialogElement);
  const confirmationSummary = element("confirmation-summary", HTMLElement);
  if (reviewRoot === undefined
    || postText === undefined
    || postVisibility === undefined
    || postMedia === undefined
    || postId === undefined
    || postVersion === undefined
    || postChecksum === undefined
    || previewExpiry === undefined
    || brandProvenance === undefined
    || brandSeries === undefined
    || brandProfileVersion === undefined
    || brandTemplate === undefined
    || brandHook === undefined
    || brandChecksum === undefined
    || brandValidation === undefined
    || validationStatus === undefined
    || validationErrors === undefined
    || createPreviewButton === undefined
    || publishButton === undefined
    || confirmation === undefined
    || confirmationSummary === undefined) {
    return;
  }
  const storageOrigin = reviewRoot.getAttribute("data-storage-origin");
  if (storageOrigin === null) return;
  const safePostText = postText;
  const safePostVisibility = postVisibility;
  const safePostMedia = postMedia;
  const safePostId = postId;
  const safePostVersion = postVersion;
  const safePostChecksum = postChecksum;
  const safePreviewExpiry = previewExpiry;
  const safeBrandProvenance = brandProvenance;
  const safeBrandSeries = brandSeries;
  const safeBrandProfileVersion = brandProfileVersion;
  const safeBrandTemplate = brandTemplate;
  const safeBrandHook = brandHook;
  const safeBrandChecksum = brandChecksum;
  const safeBrandValidation = brandValidation;
  const safeValidationStatus = validationStatus;
  const safeValidationErrors = validationErrors;
  const safeCreatePreviewButton = createPreviewButton;
  const safePublishButton = publishButton;
  const safeConfirmation = confirmation;
  const safeConfirmationSummary = confirmationSummary;

  let busy = false;
  let publishingAllowed = false;
  let terminal = false;

  function updateButtons(): void {
    safeCreatePreviewButton.disabled = busy || terminal;
    safePublishButton.disabled = busy || terminal || !publishingAllowed;
  }

  function render(view: ReviewCardView): void {
    safePostText.textContent = view.text;
    safePostVisibility.textContent = view.visibility;
    safePostId.textContent = view.postId;
    safePostVersion.textContent = String(view.version);
    safePostChecksum.textContent = view.checksum;
    safePreviewExpiry.textContent = view.previewExpiresAt ?? "Not created";
    if (view.brand === undefined) {
      safeBrandProvenance.hidden = true;
      safeBrandSeries.textContent = "";
      safeBrandProfileVersion.textContent = "";
      safeBrandTemplate.textContent = "";
      safeBrandHook.textContent = "";
      safeBrandChecksum.textContent = "";
      safeBrandValidation.textContent = "";
    } else {
      safeBrandSeries.textContent = view.brand.seriesName;
      safeBrandProfileVersion.textContent = `Version ${view.brand.profileVersion}`;
      safeBrandTemplate.textContent =
        `${view.brand.templateId} · version ${view.brand.templateVersion}`;
      safeBrandHook.textContent = view.brand.coverHook;
      safeBrandChecksum.textContent = abbreviatedChecksum(view.brand.renderChecksum);
      safeBrandValidation.textContent = view.brand.validationPassed ? "Passed" : "Failed";
      safeBrandProvenance.hidden = false;
    }
    safeValidationStatus.textContent = view.previewExpiresAt === null
      ? "Private draft loaded. Create an exact preview before publishing."
      : "Exact preview created. Review every field before publishing.";
    safeValidationErrors.replaceChildren();
    safePostMedia.replaceChildren(...view.media.map((item) => {
      const row = document.createElement("li");
      if (item.url !== null) {
        const image = document.createElement("img");
        image.src = item.url;
        image.alt = item.altText;
        image.referrerPolicy = "no-referrer";
        image.loading = "lazy";
        row.append(image);
      }
      const altText = document.createElement("p");
      altText.textContent = `Alt text: ${item.altText}`;
      row.append(altText);
      return row;
    }));
  }

  function showError(message: string): void {
    const item = document.createElement("li");
    item.textContent = message;
    safeValidationErrors.replaceChildren(item);
  }

  function showTerminal(result: PublishTerminalView): void {
    terminal = true;
    publishingAllowed = false;
    safeValidationStatus.textContent = result.message;
    safeValidationErrors.replaceChildren();
    updateButtons();
  }

  function confirmPublish(details: PublishConfirmation): Promise<boolean> {
    safeConfirmationSummary.textContent = `Publish version ${details.version} with ${details.mediaCount} image${details.mediaCount === 1 ? "" : "s"} using ${details.visibility} visibility?`;
    safeConfirmation.returnValue = "cancel";
    return new Promise((resolve) => {
      safeConfirmation.addEventListener("close", () => {
        resolve(safeConfirmation.returnValue === "confirm");
      }, { once: true });
      safeConfirmation.showModal();
    });
  }

  const ui: ReviewCardUi = {
    render,
    showError,
    setBusy(value) {
      busy = value;
      updateButtons();
    },
    setPublishingEnabled(value) {
      publishingAllowed = value;
      updateButtons();
    },
    showTerminal,
    confirm: confirmPublish
  };
  const controller = createReviewCardController({
    storageOrigin,
    globals,
    callTool: (name, arguments_) => {
      const bridge = window.openai;
      if (bridge === undefined) return Promise.reject(new Error("bridge unavailable"));
      return bridge.callTool(name, arguments_);
    },
    ui
  });

  safeCreatePreviewButton.addEventListener("click", () => {
    void controller.createPreview();
  });
  safePublishButton.addEventListener("click", () => {
    void controller.publish();
  });
  void controller.start();
}

if (typeof window !== "undefined" && typeof document !== "undefined") bootstrap();
