import { createOpencodeClient } from "@opencode-ai/sdk/v2";

const cl = createOpencodeClient({ baseUrl: "http://localhost:4096" });

// Check provider.list() for these providers
const r = await cl.provider.list();
const data = r.data;

const targets = ["opencode", "deepseek", "aihubmix"];
for (const id of targets) {
  const p = data.all.find(x => x.id === id);
  if (p) {
    console.log(`\n=== ${p.id} (${p.source}, connected: ${data.connected.includes(id)}) ===`);
    for (const [modelId, model] of Object.entries(p.models)) {
      const cost = model.cost;
      const costStr = cost ? `input=${cost.input}, output=${cost.output}` : "no cost data";
      console.log(`  ${modelId} (${model.name}) — ${costStr}`);
    }
  } else {
    console.log(`\n=== ${id} NOT FOUND ===`);
  }
}

// Also check config.providers() for what the bot was using before
console.log("\n\n=== config.providers() - for comparison ===");
const r2 = await cl.config.providers();
for (const p of r2.data.providers) {
  console.log(`  ${p.id}: ${Object.keys(p.models).length} models`);
  for (const [modelId, model] of Object.entries(p.models)) {
    console.log(`    ${model.id}`);
  }
}
