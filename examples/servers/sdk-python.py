# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "mcp==1.27.2",
#   "typing-extensions==4.16.0",
# ]
# ///

from __future__ import annotations

import argparse
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field
from typing_extensions import TypedDict


class SummaryItem(TypedDict):
    rank: int
    label: str


class Summary(TypedDict):
    topic: str
    count: int
    items: list[SummaryItem]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=43202)
    return parser.parse_args()


args = parse_args()
mcp = FastMCP(
    "interlab-python-sdk",
    host=args.host,
    port=args.port,
    stateless_http=True,
    json_response=True,
    log_level="WARNING",
)


@mcp.tool(description="Return a deterministic structured summary.", structured_output=True)
def summarize(
    topic: Annotated[str, Field(min_length=1)],
    limit: Annotated[int, Field(ge=1, le=3)] = 2,
) -> Summary:
    normalized_topic = topic.strip().lower()
    return {
        "topic": normalized_topic,
        "count": limit,
        "items": [
            {"rank": index + 1, "label": f"{normalized_topic}-{index + 1}"}
            for index in range(limit)
        ],
    }


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
