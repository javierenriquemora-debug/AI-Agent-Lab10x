import { StateGraph, Annotation, MemorySaver, Command, interrupt } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { createChatModel } from "./model";
import { augmentSystemPromptWithMemories } from "./memory-retrieval";
import { detectMemoryServiceScope } from "./memory-policy";
import { runCompactionNode } from "./nodes/compaction-node";
import {
  buildLangChainTools,
  buildPendingToolReview,
  createPendingToolCallRecord,
  executeToolCallById,
  type IntegrationSecrets,
  type PendingConfirmation,
  type PendingToolReview,
} from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";
import { toolRequiresConfirmation } from "./tools/catalog";
import {
  createLangfuseCallbackHandler,
  flushLangfuseTracing,
} from "./langfuse-graph";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  processedToolCallIds: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...prev, ...next])],
    default: () => [],
  }),
  compactionCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  compactionFailureCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

const sharedCheckpointer = new MemorySaver();

type ResumeDecision =
  | { type: "approve"; toolCallId: string }
  | { type: "reject"; message?: string }
  | { type: "edit"; toolCallId: string; editedArgs: Record<string, unknown> };

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  checkpointThreadId?: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  integrationSecrets?: IntegrationSecrets;
}

export interface AgentOutput {
  response: string | null;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
}

const MAX_TOOL_ITERATIONS = 6;

function getLastAiMessageWithToolCalls(
  state: typeof GraphState.State
): AIMessage | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (msg instanceof AIMessage && msg.tool_calls?.length) {
      return msg;
    }
  }
  return null;
}

function getToolCallKey(
  toolCall: { id?: string; name: string },
  index: number
): string {
  return toolCall.id ?? `${toolCall.name}:${index}`;
}

function getNextToolCall(
  state: typeof GraphState.State
): { key: string; id?: string; name: string; args: Record<string, unknown> } | null {
  const aiMessage = getLastAiMessageWithToolCalls(state);
  if (!aiMessage?.tool_calls?.length) return null;
  for (const [index, tc] of aiMessage.tool_calls.entries()) {
    const key = getToolCallKey(tc, index);
    if (!state.processedToolCallIds.includes(key)) {
      return { key, id: tc.id, name: tc.name, args: tc.args };
    }
  }
  return null;
}

function getInterruptedReview(
  result: unknown
): PendingToolReview | null {
  const interruptValue = (result as { __interrupt__?: Array<{ value?: unknown }> })?.__interrupt__?.[0]?.value;
  if (!interruptValue || typeof interruptValue !== "object") return null;

  const review = interruptValue as Partial<PendingToolReview>;
  if (
    typeof review.toolName === "string" &&
    review.input &&
    typeof review.message === "string"
  ) {
    return {
      toolName: review.toolName,
      input: review.input as Record<string, unknown>,
      message: review.message,
      allowedDecisions: review.allowedDecisions ?? ["approve", "reject"],
    };
  }

  return null;
}

function getInterruptedReviewFromSnapshot(
  snapshot: unknown
): PendingToolReview | null {
  const tasks = (snapshot as {
    tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }>;
  })?.tasks;

  if (!tasks?.length) return null;

  for (const task of tasks) {
    for (const interruptInfo of task.interrupts ?? []) {
      const value = interruptInfo?.value;
      if (!value || typeof value !== "object") continue;

      const review = value as Partial<PendingToolReview>;
      if (
        typeof review.toolName === "string" &&
        review.input &&
        typeof review.message === "string"
      ) {
        return {
          toolName: review.toolName,
          input: review.input as Record<string, unknown>,
          message: review.message,
          allowedDecisions: review.allowedDecisions ?? ["approve", "reject"],
        };
      }
    }
  }

  return null;
}

async function persistPendingConfirmation(
  input: AgentInput,
  review: PendingToolReview,
  checkpointThreadId: string
): Promise<PendingConfirmation> {
  const pendingConfirmation = await createPendingToolCallRecord(
    {
      db: input.db,
      userId: input.userId,
      sessionId: input.sessionId,
      enabledTools: input.enabledTools,
      integrations: input.integrations,
      integrationSecrets: input.integrationSecrets,
    },
    review,
    checkpointThreadId
  );

  await addMessage(input.db, input.sessionId, "assistant", pendingConfirmation.message, {
    tool_call_id: pendingConfirmation.toolCallId,
    structured_payload: {
      type: "pending_confirmation",
      ...pendingConfirmation,
      allowedDecisions: review.allowedDecisions,
      input: review.input,
    },
  });

  return pendingConfirmation;
}

function getResponseText(lastMessage: BaseMessage): string {
  return typeof lastMessage.content === "string"
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);
}

async function invokeGraph(
  input: AgentInput,
  invocationInput:
    | {
        messages: BaseMessage[];
        sessionId: string;
        userId: string;
        systemPrompt: string;
        processedToolCallIds: string[];
        compactionCount: number;
        compactionFailureCount: number;
      }
    | Command
): Promise<AgentOutput> {
  const {
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    integrationSecrets,
  } = input;
  const checkpointThreadId =
    input.checkpointThreadId?.trim() || `${sessionId}:${randomUUID()}`;

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    integrationSecrets,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;
  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function compactionNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    return runCompactionNode({
      messages: state.messages,
      sessionId: state.sessionId,
      compactionCount: state.compactionCount,
      compactionFailureCount: state.compactionFailureCount,
    });
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const nextToolCall = getNextToolCall(state);
    if (!nextToolCall) {
      return {};
    }

    const matchingTool = lcTools.find((t) => t.name === nextToolCall.name);
    if (!matchingTool) {
      return { processedToolCallIds: [nextToolCall.key] };
    }

    toolCallNames.push(nextToolCall.name);

    if (toolRequiresConfirmation(nextToolCall.name)) {
      const review = buildPendingToolReview(nextToolCall.name, nextToolCall.args);
      const decision = interrupt(review) as ResumeDecision;

      if (decision.type === "reject") {
        return {
          messages: [
            new ToolMessage({
              content: JSON.stringify({
                message: decision.message ?? "Acción cancelada por el usuario.",
                rejected: true,
              }),
              tool_call_id: nextToolCall.id ?? nextToolCall.key,
            }),
          ],
          processedToolCallIds: [nextToolCall.key],
        };
      }

      const execution = await executeToolCallById(
        {
          db,
          userId,
          sessionId,
          enabledTools,
          integrations,
          integrationSecrets,
        },
        decision.toolCallId,
        decision.type === "edit" ? decision.editedArgs : undefined
      );

      return {
        messages: [
          new ToolMessage({
            content: JSON.stringify(execution.result),
              tool_call_id: nextToolCall.id ?? nextToolCall.key,
          }),
        ],
          processedToolCallIds: [nextToolCall.key],
      };
    }

    let result: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await (matchingTool as any).invoke(nextToolCall.args);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown tool execution error";
      result = JSON.stringify({
        message,
        failed: true,
        toolName: nextToolCall.name,
      });
    }
    return {
      messages: [
        new ToolMessage({
          content: String(result),
          tool_call_id: nextToolCall.id ?? nextToolCall.key,
        }),
      ],
      processedToolCallIds: [nextToolCall.key],
    };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const nextToolCall = getNextToolCall(state);
    if (nextToolCall) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  function afterTools(state: typeof GraphState.State): string {
    return getNextToolCall(state) ? "tools" : "compaction";
  }

  const graph = new StateGraph(GraphState)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addConditionalEdges("tools", afterTools, {
      tools: "tools",
      compaction: "compaction",
    });

  const app = graph.compile({ checkpointer: sharedCheckpointer });
  const langfuseHandler = createLangfuseCallbackHandler({ userId, sessionId });

  let finalState: typeof GraphState.State;
  try {
    finalState = await app.invoke(invocationInput, {
      configurable: { thread_id: checkpointThreadId },
      ...(langfuseHandler
        ? { callbacks: [langfuseHandler] }
        : {}),
    });
  } finally {
    await flushLangfuseTracing();
  }
  const snapshot = await app.getState({
    configurable: { thread_id: checkpointThreadId },
  });

  const interruptedReview =
    getInterruptedReviewFromSnapshot(snapshot) ?? getInterruptedReview(finalState);
  if (interruptedReview) {
    const pendingConfirmation = await persistPendingConfirmation(
      input,
      interruptedReview,
      checkpointThreadId
    );
    return {
      response: null,
      toolCalls: toolCallNames,
      pendingConfirmation,
    };
  }

  const lastMessage = finalState.messages[finalState.messages.length - 1];
  const responseText = getResponseText(lastMessage);
  await addMessage(db, sessionId, "assistant", responseText);
  return { response: responseText, toolCalls: toolCallNames, pendingConfirmation: null };
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    sessionId,
    systemPrompt,
    db,
  } = input;
  const memoryScope = detectMemoryServiceScope({ text: message });
  const effectiveSystemPrompt = await augmentSystemPromptWithMemories({
    db,
    userId: input.userId,
    userInput: message,
    baseSystemPrompt: systemPrompt,
    scope: memoryScope,
  });

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const initialMessages: BaseMessage[] = [
    new SystemMessage(effectiveSystemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ];

  return invokeGraph(input, {
    messages: initialMessages,
    sessionId: input.sessionId,
    userId: input.userId,
    systemPrompt: effectiveSystemPrompt,
    processedToolCallIds: [],
    compactionCount: 0,
    compactionFailureCount: 0,
  });
}

export async function resumeAgent(
  input: AgentInput,
  decision: ResumeDecision
): Promise<AgentOutput> {
  return invokeGraph(input, new Command({ resume: decision }));
}
