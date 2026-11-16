/** Typed error codes returned by perplexity-web MCP tools. */
export const ErrorCode = Object.freeze({
    LOGIN_REQUIRED: "LOGIN_REQUIRED",
    CLOUDFLARE_CHALLENGE: "CLOUDFLARE_CHALLENGE",
    SELECTOR_MISSING: "SELECTOR_MISSING",
    MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
    INVALID_PARAMS: "INVALID_PARAMS",
    TIMEOUT: "TIMEOUT",
    CANCELLED: "CANCELLED",
    PROFILE_UNAVAILABLE: "PROFILE_UNAVAILABLE",
    API_ERROR: "API_ERROR",
    INTERNAL_ERROR: "INTERNAL_ERROR",
});

/** Structured error preserving diagnostic metadata and optional partial checkpoint paths. */
export class PerplexityMcpError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "PerplexityMcpError";
        this.code = code || ErrorCode.INTERNAL_ERROR;
        this.stage = options.stage || "unknown";
        this.recoverable = typeof options.recoverable === "boolean" ? options.recoverable : true;
        this.details = options.details ?? undefined;
        this.checkpointFile = options.checkpointFile ?? undefined;
        this.partialChars = typeof options.partialChars === "number" ? options.partialChars : undefined;
        this.threadUrl = options.threadUrl ?? undefined;
        this.profile = options.profile ?? undefined;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }

    toJSON() {
        const payload = {
            ok: false,
            error: {
                code: this.code,
                message: this.message,
                stage: this.stage,
                recoverable: this.recoverable,
            },
        };
        if (this.profile)
            payload.error.profile = this.profile;
        if (this.threadUrl)
            payload.error.threadUrl = this.threadUrl;
        if (this.checkpointFile)
            payload.error.checkpointFile = this.checkpointFile;
        if (typeof this.partialChars === "number")
            payload.error.partialChars = this.partialChars;
        if (this.details !== undefined)
            payload.error.details = this.details;
        return payload;
    }

    toToolErrorResult() {
        return {
            content: [{ type: "text", text: JSON.stringify(this.toJSON(), null, 2) }],
            isError: true,
        };
    }
}

/** Normalize arbitrary thrown errors into a structured PerplexityMcpError. */
export function normalizeError(err, fallbackStage = "unknown") {
    if (err instanceof PerplexityMcpError)
        return err;
    const message = err instanceof Error ? err.message : String(err);
    let code = ErrorCode.INTERNAL_ERROR;
    if (/timed out|timeout/i.test(message)) {
        code = ErrorCode.TIMEOUT;
    }
    else if (/abort|cancel/i.test(message)) {
        code = ErrorCode.CANCELLED;
    }
    else if (/cloudflare|verify you are human|captcha|turnstile/i.test(message)) {
        code = ErrorCode.CLOUDFLARE_CHALLENGE;
    }
    else if (/not authenticated|sign in|log in|session/i.test(message)) {
        code = ErrorCode.LOGIN_REQUIRED;
    }
    else if (/not found.*available models|unavailable|excluded/i.test(message)) {
        code = ErrorCode.MODEL_UNAVAILABLE;
    }
    else if (/invalid thread_url|invalid source|PERPLEXITY_API_KEY/i.test(message)) {
        code = ErrorCode.INVALID_PARAMS;
    }
    else if (/could not find|waiting for selector|selector/i.test(message)) {
        code = ErrorCode.SELECTOR_MISSING;
    }
    return new PerplexityMcpError(code, message, {
        stage: fallbackStage,
        cause: err,
    });
}
