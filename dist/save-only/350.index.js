"use strict";
exports.id = 350;
exports.ids = [350];
exports.modules = {

/***/ 2350:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FetchInstrumentation = void 0;
/*
 * Portions from https://github.com/elastic/apm-agent-nodejs
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 *
 */
const node_diagnostics_channel_1 = __importDefault(__webpack_require__(65714));
const semantic_conventions_1 = __webpack_require__(67275);
const api_1 = __webpack_require__(65163);
function getMessage(error) {
    if (error instanceof AggregateError) {
        return error.errors.map((e) => e.message).join(', ');
    }
    return error.message;
}
// Get the content-length from undici response headers.
// `headers` is an Array of buffers: [k, v, k, v, ...].
// If the header is not present, or has an invalid value, this returns null.
function contentLengthFromResponseHeaders(headers) {
    const name = 'content-length';
    for (let i = 0; i < headers.length; i += 2) {
        const k = headers[i];
        if (k.length === name.length && k.toString().toLowerCase() === name) {
            const v = Number(headers[i + 1]);
            if (!Number.isNaN(Number(v))) {
                return v;
            }
            return undefined;
        }
    }
    return undefined;
}
// A combination of https://github.com/elastic/apm-agent-nodejs and
// https://github.com/gadget-inc/opentelemetry-instrumentations/blob/main/packages/opentelemetry-instrumentation-undici/src/index.ts
class FetchInstrumentation {
    // Keep ref to avoid https://github.com/nodejs/node/issues/42170 bug and for
    // unsubscribing.
    channelSubs;
    spanFromReq = new WeakMap();
    tracer;
    config;
    meter;
    instrumentationName = 'opentelemetry-instrumentation-node-18-fetch';
    instrumentationVersion = '1.0.0';
    instrumentationDescription = 'Instrumentation for Node 18 fetch via diagnostics_channel';
    subscribeToChannel(diagnosticChannel, onMessage) {
        const channel = node_diagnostics_channel_1.default.channel(diagnosticChannel);
        channel.subscribe(onMessage);
        this.channelSubs.push({
            name: diagnosticChannel,
            channel,
            onMessage,
        });
    }
    constructor(config) {
        // Force load fetch API (since it's lazy loaded in Node 18)
        fetch('').catch(() => { });
        this.channelSubs = [];
        this.meter = api_1.metrics.getMeter(this.instrumentationName, this.instrumentationVersion);
        this.tracer = api_1.trace.getTracer(this.instrumentationName, this.instrumentationVersion);
        this.config = { ...config };
    }
    disable() {
        this.channelSubs?.forEach((sub) => sub.channel.unsubscribe(sub.onMessage));
    }
    enable() {
        this.subscribeToChannel('undici:request:create', (args) => this.onRequest(args));
        this.subscribeToChannel('undici:request:headers', (args) => this.onHeaders(args));
        this.subscribeToChannel('undici:request:trailers', (args) => this.onDone(args));
        this.subscribeToChannel('undici:request:error', (args) => this.onError(args));
    }
    setTracerProvider(tracerProvider) {
        this.tracer = tracerProvider.getTracer(this.instrumentationName, this.instrumentationVersion);
    }
    setMeterProvider(meterProvider) {
        this.meter = meterProvider.getMeter(this.instrumentationName, this.instrumentationVersion);
    }
    setConfig(config) {
        this.config = { ...config };
    }
    getConfig() {
        return this.config;
    }
    onRequest({ request }) {
        // Don't instrument CONNECT - see comments at:
        // https://github.com/elastic/apm-agent-nodejs/blob/c55b1d8c32b2574362fc24d81b8e173ce2f75257/lib/instrumentation/modules/undici.js#L24
        if (request.method === 'CONNECT') {
            return;
        }
        if (this.config.ignoreRequestHook && this.config.ignoreRequestHook(request) === true) {
            return;
        }
        const span = this.tracer.startSpan(`HTTP ${request.method}`, {
            kind: api_1.SpanKind.CLIENT,
            attributes: {
                [semantic_conventions_1.SemanticAttributes.HTTP_URL]: getAbsoluteUrl(request.origin, request.path),
                [semantic_conventions_1.SemanticAttributes.HTTP_METHOD]: request.method,
                [semantic_conventions_1.SemanticAttributes.HTTP_TARGET]: request.path,
                'http.client': 'fetch',
            },
        });
        const requestContext = api_1.trace.setSpan(api_1.context.active(), span);
        const addedHeaders = {};
        api_1.propagation.inject(requestContext, addedHeaders);
        if (this.config.onRequest) {
            this.config.onRequest({ request, span, additionalHeaders: addedHeaders });
        }
        if (Array.isArray(request.headers)) {
            request.headers.push(...Object.entries(addedHeaders).flat());
        }
        else {
            request.headers += Object.entries(addedHeaders)
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join('');
        }
        this.spanFromReq.set(request, span);
    }
    onHeaders({ request, response }) {
        const span = this.spanFromReq.get(request);
        if (span !== undefined) {
            // We are currently *not* capturing response headers, even though the
            // intake API does allow it, because none of the other `setHttpContext`
            // uses currently do.
            const cLen = contentLengthFromResponseHeaders(response.headers);
            const attrs = {
                [semantic_conventions_1.SemanticAttributes.HTTP_STATUS_CODE]: response.statusCode,
            };
            if (cLen) {
                attrs[semantic_conventions_1.SemanticAttributes.HTTP_RESPONSE_CONTENT_LENGTH] = cLen;
            }
            span.setAttributes(attrs);
            span.setStatus({
                code: response.statusCode >= 400 ? api_1.SpanStatusCode.ERROR : api_1.SpanStatusCode.OK,
                message: String(response.statusCode),
            });
        }
    }
    onDone({ request }) {
        const span = this.spanFromReq.get(request);
        if (span !== undefined) {
            span.end();
            this.spanFromReq.delete(request);
        }
    }
    onError({ request, error }) {
        const span = this.spanFromReq.get(request);
        if (span !== undefined) {
            span.recordException(error);
            span.setStatus({
                code: api_1.SpanStatusCode.ERROR,
                message: getMessage(error),
            });
            span.end();
        }
    }
}
exports.FetchInstrumentation = FetchInstrumentation;
function getAbsoluteUrl(origin, path = '/') {
    const url = `${origin}`;
    if (origin.endsWith('/') && path.startsWith('/')) {
        return `${url}${path.slice(1)}`;
    }
    if (!origin.endsWith('/') && !path.startsWith('/')) {
        return `${url}/${path.slice(1)}`;
    }
    return `${url}${path}`;
}
//# sourceMappingURL=index.js.map

/***/ })

};
;