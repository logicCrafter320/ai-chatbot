import { Router } from "express";
import { db } from "@workspace/db";
import { conversations, messages } from "@workspace/db";
import { eq, isNull, isNotNull } from "drizzle-orm";
import {
  GetOpenaiConversationParams,
  DeleteOpenaiConversationParams,
  ListOpenaiMessagesParams,
  SendOpenaiMessageParams,
  SendOpenaiMessageBody,
  CreateOpenaiConversationBody,
} from "@workspace/api-zod";
import OpenAI from "openai";

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const SYSTEM_PROMPT =
  "You are a helpful, friendly, and concise AI assistant. Answer clearly and in simple language.";

const router = Router();

router.get("/openai/conversations", async (req, res) => {
  const archived = req.query.archived === "true";
  const all = await db
    .select()
    .from(conversations)
    .where(archived ? isNotNull(conversations.archivedAt) : isNull(conversations.archivedAt))
    .orderBy(conversations.createdAt);
  res.json(all.map((c) => ({
    ...c,
    createdAt: c.createdAt.toISOString(),
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
  })));
});

router.post("/openai/conversations", async (req, res) => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const [created] = await db
    .insert(conversations)
    .values({ title: parsed.data.title })
    .returning();
  res.status(201).json({ ...created, createdAt: created.createdAt.toISOString(), archivedAt: null });
});

router.get("/openai/conversations/:id", async (req, res) => {
  const parsed = GetOpenaiConversationParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, parsed.data.id),
  });
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, parsed.data.id))
    .orderBy(messages.createdAt);
  res.json({
    ...conv,
    createdAt: conv.createdAt.toISOString(),
    archivedAt: conv.archivedAt ? conv.archivedAt.toISOString() : null,
    messages: msgs.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
  });
});

router.patch("/openai/conversations/:id/archive", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const existing = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const [updated] = await db
    .update(conversations)
    .set({ archivedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning();
  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), archivedAt: updated.archivedAt!.toISOString() });
});

router.patch("/openai/conversations/:id/unarchive", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const existing = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const [updated] = await db
    .update(conversations)
    .set({ archivedAt: null })
    .where(eq(conversations.id, id))
    .returning();
  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), archivedAt: null });
});

router.delete("/openai/conversations/:id", async (req, res) => {
  const parsed = DeleteOpenaiConversationParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const existing = await db.query.conversations.findFirst({
    where: eq(conversations.id, parsed.data.id),
  });
  if (!existing) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  await db.delete(messages).where(eq(messages.conversationId, parsed.data.id));
  await db.delete(conversations).where(eq(conversations.id, parsed.data.id));
  res.status(204).send();
});

router.get("/openai/conversations/:id/messages", async (req, res) => {
  const parsed = ListOpenaiMessagesParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, parsed.data.id))
    .orderBy(messages.createdAt);
  res.json(msgs.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })));
});

router.post("/openai/conversations/:id/messages", async (req, res) => {
  const paramsParsed = SendOpenaiMessageParams.safeParse({ id: Number(req.params.id) });
  const bodyParsed = SendOpenaiMessageBody.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const convId = paramsParsed.data.id;
  const userContent = bodyParsed.data.content;

  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, convId),
  });
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  await db.insert(messages).values({
    conversationId: convId,
    role: "user",
    content: userContent,
  });

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  const chatMessages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  try {
    const stream = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...chatMessages,
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    await db.insert(messages).values({
      conversationId: convId,
      role: "assistant",
      content: fullResponse,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    req.log.error({ err }, "Groq streaming error");
    res.write(`data: ${JSON.stringify({ error: "AI error occurred" })}\n\n`);
    res.end();
  }
});

export default router;
