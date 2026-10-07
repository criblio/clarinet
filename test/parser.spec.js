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
});
