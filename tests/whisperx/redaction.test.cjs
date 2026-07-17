const test = require("node:test");
const assert = require("node:assert/strict");

const {
  redactText,
  redactObjectStrings,
  isSensitiveEnvKey,
  BoundedRedactedCapture,
  REDACTED,
} = require("../../src/helpers/whisperx/redaction");

test("redactText", async (t) => {
  await t.test("hf_ token is redacted", () => {
    const out = redactText("My token is hf_abcdefghij1234567890 for auth");
    assert.ok(!out.includes("hf_abcdefghij1234567890"));
    assert.ok(out.includes(REDACTED));
  });

  await t.test('"Bearer abcdef123456" redacted preserving the word Bearer', () => {
    const out = redactText("Bearer abcdef123456");
    assert.ok(out.includes("Bearer"));
    assert.ok(out.includes(REDACTED));
    assert.ok(!out.includes("abcdef123456"));
  });

  await t.test("HUGGINGFACE_TOKEN=hf_x form redacted", () => {
    const out = redactText("HUGGINGFACE_TOKEN=hf_x");
    assert.ok(out.includes(REDACTED));
    assert.ok(!out.includes("hf_x"));
  });

  await t.test("hf_token: 'value' form redacted", () => {
    const out = redactText("hf_token: 'super-secret-value'");
    assert.ok(out.includes(REDACTED));
    assert.ok(!out.includes("super-secret-value"));
  });

  await t.test('api_key="v" form redacted', () => {
    const out = redactText('api_key="my-secret-value"');
    assert.ok(out.includes(REDACTED));
    assert.ok(!out.includes("my-secret-value"));
  });

  await t.test("C:\\Users\\Marco path redacted to <home>", () => {
    const out = redactText("C:\\Users\\Marco");
    assert.equal(out, "<home>");
  });

  await t.test("/home/marco redacted to <home>", () => {
    const out = redactText("Logs stored at /home/marco/cache");
    assert.ok(out.includes("<home>"));
    assert.ok(!out.includes("/home/marco"));
  });

  await t.test("/Users/marco redacted to <home>", () => {
    const out = redactText("Logs stored at /Users/marco/cache");
    assert.ok(out.includes("<home>"));
    assert.ok(!out.includes("/Users/marco"));
  });

  await t.test("plain text is unchanged", () => {
    const text = "Hello world, nothing sensitive here.";
    assert.equal(redactText(text), text);
  });
});

test("isSensitiveEnvKey", async (t) => {
  const sensitive = ["HUGGINGFACE_TOKEN", "OPENAI_API_KEY", "MY_PASSWORD"];
  for (const key of sensitive) {
    await t.test(`${key} is sensitive`, () => {
      assert.equal(isSensitiveEnvKey(key), true);
    });
  }
  const notSensitive = ["PATH", "TEMP", "CUDA_VISIBLE_DEVICES"];
  for (const key of notSensitive) {
    await t.test(`${key} is not sensitive`, () => {
      assert.equal(isSensitiveEnvKey(key), false);
    });
  }
});

test("redactObjectStrings", async (t) => {
  await t.test("redacts nested string values", () => {
    const out = redactObjectStrings({
      nested: { note: "contact at /home/marco/project", other: "fine" },
    });
    assert.ok(out.nested.note.includes("<home>"));
    assert.equal(out.nested.other, "fine");
  });

  await t.test("replaces the value of sensitive keys entirely", () => {
    const out = redactObjectStrings({ apiKey: "supersecretvalue" });
    assert.equal(out.apiKey, REDACTED);
  });

  await t.test("recurses through arrays", () => {
    const out = redactObjectStrings({
      arr: ["hf_abcdefghij1234567890", "ok"],
    });
    assert.equal(out.arr[1], "ok");
    assert.ok(!out.arr[0].includes("hf_abcdefghij1234567890"));
  });
});

test("BoundedRedactedCapture", async (t) => {
  await t.test("append beyond maxBytes truncates and prefixes output", () => {
    const cap = new BoundedRedactedCapture(10);
    cap.append("AAAAA"); // 5 bytes
    cap.append("BBBBB"); // 10 bytes total, no drop yet
    cap.append("CCCCC"); // 15 bytes total, drops oldest chunk
    assert.equal(cap.truncated, true);
    const out = cap.toRedactedString();
    assert.ok(out.startsWith("[truncated]"));
  });

  await t.test("redaction is applied to captured content", () => {
    const cap = new BoundedRedactedCapture(1_000_000);
    cap.append("token leaked: hf_abcdefghij1234567890");
    const out = cap.toRedactedString();
    assert.ok(out.includes(REDACTED));
    assert.ok(!out.includes("hf_abcdefghij1234567890"));
  });
});
