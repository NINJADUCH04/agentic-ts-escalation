import "dotenv/config";
import { z } from "zod";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGroq } from "@langchain/groq";
import { pool } from "./db";
import { ChatOllama } from "@langchain/ollama";
import {
  Annotation,
  StateGraph,
  START,
  END,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";

// ==========================================
// 1. STATE DEFINITION (With Message Reducers)
// ==========================================
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (curr, update) => curr.concat(update),
    default: () => [],
  }),
  orderStatus: Annotation<string | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  refundApproved: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),
});

// ==========================================
// 2. TOOLS WITH STRICT ZOD SCHEMAS
// ==========================================
const lookupOrderTool = tool(
  async ({ orderId }) => {
    // Simulated DB lookup
    if (orderId === "ORD-101") {
      return JSON.stringify({
        id: "ORD-101",
        item: "Wireless Noise-Canceling Headphones",
        sku: "SKU-HPH-01",
        price: 150.0,
        status: "shipped_damaged",
      });
    }
    return JSON.stringify({ error: "Order not found" });
  },
  {
    name: "lookup_order",
    description: "Look up order details and status given an order ID.",
    schema: z.object({
      orderId: z.string().describe("The ID of the customer order, e.g. ORD-101"),
    }),
  }
);

const checkInventoryTool = tool(
  async ({ sku }) => {
    // Simulated warehouse inventory service
    if (sku === "SKU-HPH-01") {
      return JSON.stringify({ sku: "SKU-HPH-01", stockCount: 0, backordered: true });
    }
    return JSON.stringify({ sku, stockCount: 45, backordered: false });
  },
  {
    name: "check_inventory",
    description: "Check stock availability in the warehouse for a replacement SKU.",
    schema: z.object({
      sku: z.string().describe("The product SKU identifier"),
    }),
  }
);
export const refundTool = tool(
  async ({ amount, orderId, reason }) => {
    // amount will guaranteed be a number here (e.g. 0 instead of "0")
    return `Refunded ${amount} for order ${orderId}`;
  },
  {
    name: "refund_order",
    description: "Issue a refund for an order",
    schema: z.object({
      amount: z.coerce.number().describe("The amount to refund as a number"), // <-- Use z.coerce.number()
      orderId: z.string(),
      reason: z.string(),
    }),
  }
);
const createRefundTool = tool(
  async ({ orderId, amount, reason }) => {
    // High-risk mutation: ledger write / financial transaction
    return JSON.stringify({
      status: "refund_processed",
      transactionId: "TXN-98213",
      orderId,
      amount,
      reason,
      timestamp: new Date().toISOString(),
    });
  },
  {
    name: "create_refund",
    description: "Issue a financial refund back to the customer's payment method.",
    schema: z.object({
      orderId: z.string().describe("The order ID to refund"),
      reason: z.string().describe("Justification for the refund"),
    }),
  }
);

const tools = [lookupOrderTool, checkInventoryTool, createRefundTool];
const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

// ==========================================
// 3. MODEL INITIALIZATION
// ==========================================
const model = new ChatOllama({
  model: "llama3.2:latest",
  temperature: 0,
}).bindTools(tools);

// ==========================================
// 4. GRAPH NODES
// ==========================================

// Orchestration / Reasoning Node
async function agentNode(state: typeof AgentState.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

// Deterministic Tool Execution Node
async function toolsNode(state: typeof AgentState.State) {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
  const toolCalls = lastMessage.tool_calls || [];
  const results: ToolMessage[] = [];

  let detectedOrderStatus: string | null = null;

  for (const call of toolCalls) {
    const selectedTool = toolsByName[call.name];
    if (!selectedTool) {
      throw new Error(`Tool ${call.name} not registered in dispatcher.`);
    }
    
    // 1. Defensively parse arguments into an object
  const args = typeof call.args === "string" ? JSON.parse(call.args) : (call.args ?? {});

  // 2. Cast selectedTool to StructuredToolInterface (or any) to invoke across heterogeneous tool unions
  const output = await (selectedTool as StructuredToolInterface).invoke(args);

    // Track order status metadata when inspected
    if (call.name === "lookup_order") {
      try {
        const parsed = JSON.parse(output as string);
        if (parsed.status) detectedOrderStatus = parsed.status;
      } catch {
        // Fallback for non-JSON returns
      }
    }

    results.push(
      new ToolMessage({
        tool_call_id: call.id!,
        name: call.name,
        content: typeof output === "string" ? output : JSON.stringify(output),
      })
    );
  }

  return {
    messages: results,
    ...(detectedOrderStatus ? { orderStatus: detectedOrderStatus } : {}),
  };
}

// ==========================================
// 5. ROUTING & CONDITIONAL EDGES
// ==========================================
function shouldContinue(state: typeof AgentState.State): string {
  const lastMessage = state.messages[state.messages.length - 1] as AIMessage;

  // If no tools requested, complete turn
  if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
    return END;
  }

  return "tools";
}

// ==========================================
// 6. GRAPH COMPILATION WITH PERSISTENCE
// ==========================================
export const checkpointer = new PostgresSaver(pool);

const workflow = new StateGraph(AgentState)
  .addNode("agent", agentNode)
  .addNode("tools", toolsNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, ["tools", END])
  .addEdge("tools", "agent");

// Set interruption BEFORE the tools node ONLY when a high-risk mutation is present
export const app = workflow.compile({
  checkpointer,
  interruptBefore: ["tools"],
});