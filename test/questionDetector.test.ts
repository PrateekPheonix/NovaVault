import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QuestionDetector, type TranscriptChunk } from "../src/detect/questionDetector.ts";

const partial = (text: string, atMs: number): TranscriptChunk =>
  ({ text, isFinal: false, atMs, speaker: "interviewer" });
const final = (text: string, atMs: number): TranscriptChunk =>
  ({ text, isFinal: true, atMs, speaker: "interviewer" });

describe("QuestionDetector", () => {
  describe("the §9 failure mode: never fire on partials", () => {
    test("progressive partials stay silent until the final chunk lands", () => {
      const d = new QuestionDetector();
      // Exactly the sequence the PRD calls out.
      for (const [i, p] of [
        "I wanted to ask...",
        "I wanted to ask how...",
        "I wanted to ask how you would...",
        "I wanted to ask how you would design...",
      ].entries()) {
        assert.equal(d.push(partial(p, i * 100)), null, `partial "${p}" must not fire`);
      }

      // Final arrives, but with a period rather than a question mark.
      assert.equal(d.push(final("I wanted to ask how you would design a URL shortener.", 500)), null);

      // Still mid-utterance - too soon to answer.
      assert.equal(d.tick(900), null);

      // Speaker has clearly stopped.
      const q = d.tick(1500);
      assert.ok(q, "should fire once the speaker has stopped");
      assert.equal(q.text, "I wanted to ask how you would design a URL shortener.");
      assert.equal(q.reason, "silence-after-interrogative");
    });

    test("a partial that already looks like a full question still does not fire", () => {
      const d = new QuestionDetector();
      assert.equal(d.push(partial("What is a hash map?", 0)), null);
    });
  });

  describe("firing paths", () => {
    test("a question mark fires immediately, without waiting for silence", () => {
      const d = new QuestionDetector();
      const q = d.push(final("How would you design a rate limiter?", 100));
      assert.ok(q);
      assert.equal(q.reason, "terminal-question-mark");
      assert.equal(q.confidence, 0.95);
    });

    test("an imperative prompt with no question mark still fires", () => {
      const d = new QuestionDetector();
      const q = d.push(final("Tell me about a time you handled a production incident.", 100));
      assert.ok(q, "'Tell me about...' is a question in every sense that matters");
      assert.equal(q.reason, "imperative-prompt");
    });

    test("a bare follow-up fires", () => {
      const d = new QuestionDetector();
      const q = d.push(final("Why?", 100));
      assert.ok(q);
      assert.equal(q.text, "Why?");
    });

    test("chunks accumulate across finals into one question", () => {
      const d = new QuestionDetector();
      assert.equal(d.push(final("So for the next part,", 100)), null);
      const q = d.push(final("how would you shard that table?", 200));
      assert.ok(q);
      assert.equal(q.text, "So for the next part, how would you shard that table?");
    });
  });

  describe("things that must not fire", () => {
    test("acknowledgements are ignored even with a question mark", () => {
      for (const ack of ["Okay.", "Right.", "Got it.", "Makes sense.", "Yeah?", "Really?"]) {
        const d = new QuestionDetector();
        assert.equal(d.push(final(ack, 100)), null, `"${ack}" must not fire`);
      }
    });

    test("candidate speech never triggers a question", () => {
      const d = new QuestionDetector();
      const chunk: TranscriptChunk = {
        text: "So how should I approach this?", isFinal: true, atMs: 100, speaker: "candidate",
      };
      assert.equal(d.push(chunk), null);
      assert.equal(d.tick(5000), null);
    });

    test("a plain statement is dropped on silence rather than answered", () => {
      const d = new QuestionDetector();
      d.push(final("We have about twenty minutes left for this section.", 100));
      assert.equal(d.tick(2000), null);
      assert.equal(d.pending, "", "buffer must clear so it cannot contaminate the next question");
    });

    test("the same question is never answered twice", () => {
      const d = new QuestionDetector();
      assert.ok(d.push(final("What is your experience with Kafka?", 100)));
      assert.equal(d.push(final("What is your experience with Kafka?", 900)), null);
    });

    test("a different question after one that fired still fires", () => {
      const d = new QuestionDetector();
      assert.ok(d.push(final("What is a B-tree?", 100)));
      assert.ok(d.push(final("And how does it differ from an LSM tree?", 400)));
    });
  });

  describe("state handling", () => {
    test("pending exposes accumulated text and clears after firing", () => {
      const d = new QuestionDetector();
      d.push(final("Just to follow up on that,", 100));
      assert.equal(d.pending, "Just to follow up on that,");
      d.push(final("what would you change?", 200));
      assert.equal(d.pending, "");
    });

    test("reset clears buffered text and dedupe history", () => {
      const d = new QuestionDetector();
      const q = "What is a deadlock?";
      assert.ok(d.push(final(q, 100)));
      d.reset();
      assert.ok(d.push(final(q, 200)), "after reset the same question may fire again");
    });

    test("empty and whitespace-only chunks are ignored", () => {
      const d = new QuestionDetector();
      assert.equal(d.push(final("   ", 100)), null);
      assert.equal(d.pending, "");
    });

    test("silence with an empty buffer is a no-op", () => {
      const d = new QuestionDetector();
      assert.equal(d.tick(99999), null);
    });

    test("silenceMs is configurable", () => {
      const d = new QuestionDetector({ silenceMs: 200 });
      d.push(final("I was wondering how you would test that.", 100));
      assert.equal(d.tick(250), null, "250 - 100 = 150ms, under the 200ms threshold");
      assert.ok(d.tick(400), "300ms of silence exceeds the threshold");
    });
  });
});
