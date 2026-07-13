# MCP Interlab

Find behavioral differences between MCP server implementations and reduce a failing session to a small reproducer.

```bash
npx mcp-interlab run matrix.yml
npx mcp-interlab minimize results/run.json --matrix matrix.yml
npx mcp-interlab report results/run.json --format markdown
```

MCP Interlab supports Streamable HTTP server targets, deterministic structural comparison, fresh-process delta minimization, schema-validity preservation, and a bundled regression corpus.

See the [full documentation](https://github.com/etherman-os/mcp-interlab#readme) for matrix and case formats, security guidance, examples, and current limitations.

License: MIT.
