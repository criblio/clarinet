"use strict";

const { parser } = require("..");
const clarinet = require("..");
const assert = require("assert");

/**
 * TestListener uses the events emitted by the Clarinet.js parser to rebuild the original object.
 * It is convenient for writing tests that work by 'deepEqual()' comparing the result with the
 * result from 'JSON.parse()'.
 */
class TestListener {
  constructor(parser) {
    this.reset();

    parser.onready = () => {
      this.previousStates.length = 0;
      this.currentState.container.length = 0;
    };

    parser.onopenobject = (name) => {
      this.openContainer({});
      typeof name === "undefined" || parser.onkey(name);
    };

    parser.onkey = (name) => {
      this.currentState.key = name;
    };

    parser.oncloseobject = () => {
      this.closeContainer();
    };

    parser.onopenarray = () => {
      this.openContainer([]);
    };

    parser.onclosearray = () => {
      this.closeContainer();
    };

    parser.onvalue = (value) => {
      this.pushOrSet(value);
    };

    parser.onerror = (error) => {
      throw error;
    };

    parser.onend = () => {
      this.result = this.currentState.container.pop();
    };
  }

  reset() {
    this.result = void 0;
    this.previousStates = [];
    this.currentState = Object.freeze({ container: [], key: null });
  }

  pushOrSet(value) {
    const { container, key } = this.currentState;
    if (key !== null) {
      // eslint-disable-next-line security/detect-object-injection
      container[key] = value;
      this.currentState.key = null;
    } else {
      container.push(value);
    }
  }

  openContainer(newContainer) {
    this.pushOrSet(newContainer);
    this.previousStates.push(this.currentState);
    this.currentState = { container: newContainer, key: null };
  }

  closeContainer() {
    this.currentState = this.previousStates.pop();
  }
}

// tslint:disable:object-literal-sort-keys
const literalCases = [
  { type: "null", cases: ["null"] },
  { type: "boolean", cases: ["true", "false"] },
  { type: "integer", cases: ["0", "9007199254740991", "-9007199254740991"] },
  {
    type: "real",
    cases: [
      "1E1",
      "0.1e1",
      "1e-1",
      "1e+00",
      JSON.stringify(Number.MAX_VALUE),
      JSON.stringify(Number.MIN_VALUE),
    ]
  }
];
// tslint:enable:object-literal-sort-keys

const stringLiterals = [
  ["empty", JSON.stringify("")],
  ["space", JSON.stringify(" ")],
  ["quote", JSON.stringify("\"")],
  ["backslash", JSON.stringify("\\")],
  ["slash", "\"/ & \\/\""],
  ["control", JSON.stringify("\b\f\n\r\t")],
  ["unicode", JSON.stringify("\u0022")],
  ["non-unicode", JSON.stringify("&#34; %22 0x22 034 &#x22;")],
  ["surrogate", "\"😀\""],
];

const arrayLiterals = [
  "[]",
  "[null]",
  "[true, false]",
  "[0,1, 2,  3,\n4]",
  "[[\"2 deep\"]]",
];

const objectLiterals = [
  "{}",
  "\n {\n \"\\b\"\n :\n\"\"\n }\n ",
  "{\"\":\"\"}",
  "{\"1\":{\"2\":\"deep\"}}",
];

const parse = (json) => {
  const p = parser();
  const sink = new TestListener(p);
  p.write(json);
  p.close();
  return sink.result;
};

const test = (json, description) => {
  const expected = JSON.parse(json);
  it(`${JSON.stringify(json)} -> ${JSON.stringify(expected)}${
    description
      ? ` (${description})`
      : ""
  }`, () => {
    const actual = parse(json);
    assert.deepStrictEqual(actual, expected);
  });
};

for (const cases of literalCases) {
  describe(`${cases.type} literal`, () => {
    for (const json of cases.cases) {
      stringLiterals.push([`quoted ${cases.type}`, `"${json}"`]);
      // Clarinet does not current support (null | boolean | number | string) as root value.
      // To work around this, we wrap the literal in an array before passing to 'test()'.
      // (See: https://github.com/dscape/clarinet/issues/49)
      test(`[${json}]`);
    }
  });
}

describe("string literal", () => {
  for (const [description, json] of stringLiterals) {
      // Clarinet does not current support (null | boolean | number | string) as root value.
      // To work around this, we wrap the literal in an array before passing to 'test()'.
      // (See: https://github.com/dscape/clarinet/issues/49)
      test(`[${json}]`, description);
  }
});

describe("array literal", () => {
  for (const json of arrayLiterals) {
    test(json);
  }
});

describe("object literal", () => {
  for (const json of objectLiterals) {
    test(json);
  }
});

describe("truncate option", () => {

  const parseValues = (opt, json, chunkSize) => {
    const p = parser(opt);
    const values = [];
    p.onvalue = (value, truncated, originalLength) => {
      values.push({ value, truncated, originalLength });
    };
    p.onerror = (e) => { throw e; };
    if (chunkSize) {
      for (let i = 0; i < json.length; i += chunkSize) {
        p.write(json.substring(i, i + chunkSize));
      }
    } else {
      p.write(json);
    }
    p.close();
    return values;
  };

  it("leaves strings under the maximum size untouched", () => {
    const [{ value, truncated, originalLength }] =
      parseValues({ truncate: 50 }, JSON.stringify(["hello"]));
    assert.strictEqual(value, "hello");
    assert.strictEqual(truncated, false);
    assert.strictEqual(originalLength, 5);
  });

  it("truncates the middle of strings that reach the maximum size", () => {
    // 120 chars; with truncate: 50 the head keeps 16 and the tail keeps 15
    const str = "a".repeat(60) + "b".repeat(60);
    const [{ value, truncated, originalLength }] =
      parseValues({ truncate: 50 }, JSON.stringify([str]));
    assert.strictEqual(truncated, true);
    assert.strictEqual(originalLength, 120);
    assert.strictEqual(value, str.substring(0, 16) + '...[TRUNCATED=89]...'
      + str.substring(105));
    assert.strictEqual(value.length, 51);
  });

  it("truncates streamed strings once they reach the MAX_BUFFER_LENGTH", () => {
    // 1000 chars; head keeps 43 and the tail keeps 42
    const str = "x".repeat(1000);
    const [{ value, truncated, originalLength }] =
      parseValues({ truncate: true, MAX_BUFFER_LENGTH: 100 }, JSON.stringify([str]), 13);
    assert.strictEqual(truncated, true);
    assert.strictEqual(originalLength, 1000);
    assert.strictEqual(value, str.substring(0, 41) + `...[TRUNCATED=919]...`
      + str.substring(1000 - 40));
    assert.strictEqual(value.length, 102);
  });

  it("raises an error for oversized strings when truncate is not set", () => {
    assert.throws(
      () => parseValues({MAX_BUFFER_LENGTH: 100}, JSON.stringify(["y".repeat(1000)]), 7),
      /Max buffer length exceeded: textNode/
    );
  });

  it("parses numbers longer than NUMBER_MAX_BUFFER_LENGTH as a rounded value", () => {
    const longNumber = "1." + "1".repeat(420);
    const [{ value }] =
        parseValues({}, `[${longNumber}]`, 13);
    assert.strictEqual(value, 1.1111111111111112);
  });

  it("parses exponential notation (e+) numbers longer than NUMBER_MAX_BUFFER_LENGTH as Infinity", () => {
    const longNumber = "1e+" + "1".repeat(420);
    const [{ value }] =
        parseValues({}, `[${longNumber}]`, 13);
    assert.strictEqual(value, Infinity);
  });

  it("parses exponential notation (e-) numbers longer than NUMBER_MAX_BUFFER_LENGTH as 0", () => {
    const longNumber = "1e-" + "1".repeat(420);
    const [{ value }] =
        parseValues({}, `[${longNumber}]`, 13);
    assert.strictEqual(value, 0);
  });

  it("parses numbers longer than NUMBER_MAX_BUFFER_LENGTH as Infinity", () => {
    const longNumber = "1" + "0".repeat(420);
    const [{ value }] =
      parseValues({}, `[${longNumber}]`, 13);
    assert.strictEqual(value, Infinity);
  });

  it("parses negative numbers longer than NUMBER_MAX_BUFFER_LENGTH as -Infinity", () => {
    const longNumber = "-1" + "0".repeat(420);
    const [{ value }] =
      parseValues({}, `[${longNumber}]`, 13);
    assert.strictEqual(value, -Infinity);
  });

  it("supports a custom marker", () => {
    const str = "z".repeat(100);
    const [{ value, truncated, originalLength }] =
      parseValues({ truncate: 40, truncateMarker: "[...]" },
        JSON.stringify([str]));
    assert.strictEqual(truncated, true);
    assert.strictEqual(originalLength, 100);
    assert.strictEqual(value, str.substring(0, 18) + "[...]"
      + str.substring(100 - 17));
    assert.strictEqual(value.length, 40);
  });

  it("resets the truncation state between values", () => {
    const values = parseValues({ truncate: 50 },
      JSON.stringify(["a".repeat(120), "short", "b".repeat(200)]));
    assert.deepStrictEqual(values.map((v) => v.truncated),
      [true, false, true]);
    assert.deepStrictEqual(values.map((v) => v.originalLength),
      [120, 5, 200]);
    assert.strictEqual(values[1].value, "short");
  });

  it("also reports truncation for object keys", () => {
    const p = parser({ truncate: 30 });
    const keys = [];
    p.onkey = (key, truncated, originalLength) => {
      keys.push({ key, truncated, originalLength });
    };
    p.onerror = (e) => { throw e; };
    p.write(JSON.stringify({ first: 1, a: 2 }));
    p.close();
    assert.deepStrictEqual(keys,
      [{ key: "a", truncated: false, originalLength: 1 }]);
  });

  it("emits the same value whatever the chunk size the string arrives in", () => {
    // The truncated value is retained split apart (head + sliding tail) and
    // only composed when the value closes, so the number of writes the
    // string spans must not be observable in what is emitted.
    const str = "a".repeat(500) + "b".repeat(500) + "c".repeat(500);
    const json = JSON.stringify([str]);
    const single = parseValues({ truncate: 200 }, json);
    for (const chunkSize of [1, 7, 13, 64, 199, 200, 201, 512, 1024]) {
      assert.deepStrictEqual(parseValues({ truncate: 200 }, json, chunkSize),
        single, `chunk size ${chunkSize} disagrees with a single write`);
    }
    const [{ value, truncated, originalLength }] = single;
    assert.strictEqual(truncated, true);
    assert.strictEqual(originalLength, 1500);
    assert.strictEqual(value, str.substring(0, 91)
      + "...[TRUNCATED=1319]..." + str.substring(1500 - 90));
  });

  it("still extracts a sibling field after an oversized string", () => {
    const p = parser({ truncate: 100 });
    const pairs = [];
    let key;
    // the first key of an object is delivered with onopenobject
    p.onopenobject = (k) => { key = k; };
    p.onkey = (k) => { key = k; };
    p.onvalue = (value, truncated) => { pairs.push({ key, value, truncated }); };
    p.onerror = (e) => { throw e; };
    const json = JSON.stringify({ blob: "x".repeat(10000), cursor: "ok" });
    for (let i = 0; i < json.length; i += 16) {
      p.write(json.substring(i, i + 16));
    }
    p.close();
    assert.deepStrictEqual(pairs.map((pair) => pair.key), ["blob", "cursor"]);
    assert.strictEqual(pairs[0].truncated, true);
    assert.deepStrictEqual(pairs[1], { key: "cursor", value: "ok", truncated: false });
  });

  it("keeps the truncation cost independent of the chunk size", () => {
    // Regression guard for CRIBL-46514: truncateTextNode used to rebuild the
    // whole capped value on every write once the cap was passed, so the cost
    // tracked the number of writes rather than the size of the input -- a
    // 24 MiB string took ~5.8s in 8 KiB chunks against ~41ms in one write.
    //
    // Counting the truncation work rather than timing it keeps this
    // assertion deterministic and machine-independent: parser.truncatedChars
    // advances exactly once per truncation pass, so the number of times it
    // moves is the number of cap-sized copies the old code would have made.
    const cap = 1 << 10;
    const json = `{"blob":"${"a".repeat(64 << 10)}","cursor":"ok"}`;

    const passesAtChunkSize = (chunkSize) => {
      const p = parser({ truncate: cap });
      let cursor;
      let key;
      p.onkey = (k) => { key = k; };
      p.onvalue = (value) => { if (key === "cursor") cursor = value; };
      p.onerror = (e) => { throw e; };
      let passes = 0;
      let writes = 0;
      let seen = 0;
      for (let i = 0; i < json.length; i += chunkSize) {
        p.write(json.substring(i, i + chunkSize));
        writes++;
        // only count increases: closeValue resets the counter to 0
        if (p.truncatedChars > seen) passes++;
        seen = p.truncatedChars;
      }
      p.close();
      // the point of truncating in the first place
      assert.strictEqual(cursor, "ok");
      return { passes, writes };
    };

    const small = passesAtChunkSize(1 << 6);   //   64 byte chunks
    const large = passesAtChunkSize(1 << 12);  // 4096 byte chunks

    // A slide is re-armed a bit under a cap further along the input, so the
    // number of passes is bounded by the input size over the cap however the
    // input is chopped up. The bound is generous (4x) because the re-arm
    // distance is cap - tailLen rather than a full cap, and a check only
    // happens at the end of a write; what matters is that it is a function
    // of the input alone. Before the fix every write past the cap bought one
    // full rebuild, so passes was the write count: that is 1009 here at 64
    // byte chunks, well over the bound, and it grew as chunks got smaller.
    const maxPasses = 4 * Math.ceil(json.length / cap);
    assert.ok(small.writes > 20 * large.writes,
      "the two chunk sizes should differ by a large factor of writes");
    for (const [label, run] of [["64 byte", small], ["4096 byte", large]]) {
      assert.ok(run.passes <= maxPasses,
        `truncation work tracks the write count rather than the input size: `
        + `${run.passes} passes in ${run.writes} writes at ${label} chunks, `
        + `expected at most ${maxPasses} for this input`);
    }
  });
});
