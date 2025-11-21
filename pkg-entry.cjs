#!/usr/bin/env node
// pkg 的入口包装，动态加载编译后的 ESM 入口
import('./dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
