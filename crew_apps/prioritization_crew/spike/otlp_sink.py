"""A minimal OTLP/gRPC trace receiver on :4317, for the spike only.

The Foundry Toolkit collector was not running during the spike. This stands
in for it to prove spans leave the app and arrive intact. It prints one line
per span and writes them all to results/otlp_spans.json.
"""

import json
import sys
from concurrent import futures

import grpc
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2, trace_service_pb2_grpc

from common import RESULTS_DIR

SPANS: list[dict] = []


class Sink(trace_service_pb2_grpc.TraceServiceServicer):
    def Export(self, request, context):
        for rs in request.resource_spans:
            service = next((a.value.string_value for a in rs.resource.attributes if a.key == "service.name"), "?")
            for ss in rs.scope_spans:
                for s in ss.spans:
                    attrs = {a.key: (a.value.string_value or a.value.int_value or a.value.bool_value)
                             for a in s.attributes}
                    dur_ms = (s.end_time_unix_nano - s.start_time_unix_nano) / 1e6
                    SPANS.append({"service": service, "name": s.name, "duration_ms": dur_ms,
                                  "trace_id": s.trace_id.hex(), "parent": s.parent_span_id.hex(), "attrs": attrs})
                    print(f"[sink] {service} | {s.name} | {dur_ms:.0f} ms", flush=True)
        (RESULTS_DIR / "otlp_spans.json").write_text(json.dumps(SPANS, indent=2, default=str))
        return trace_service_pb2.ExportTraceServiceResponse()


if __name__ == "__main__":
    port = sys.argv[1] if len(sys.argv) > 1 else "4317"
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    trace_service_pb2_grpc.add_TraceServiceServicer_to_server(Sink(), server)
    server.add_insecure_port(f"127.0.0.1:{port}")
    server.start()
    print(f"[sink] listening on 127.0.0.1:{port}", flush=True)
    server.wait_for_termination()
