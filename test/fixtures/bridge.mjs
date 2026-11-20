// Test stand-in for upstream's /app/bridge.mjs: echoes stdin back and exits 0.
process.stdin.pipe(process.stdout);
