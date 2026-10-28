import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { app } from "./agents";
import { HumanMessage, AIMessage } from "@langchain/core/messages";

async function runSession() {
  const rl = readline.createInterface({ input, output });

  // Session ID mapped to SQLite checkpointer
  const threadId = "support-session-901";
  const config = { configurable: { thread_id: threadId } };

  console.log("=== Support Agent Active ===");
  const userPrompt =
    "Hello, my order ORD-101 arrived damaged. Can I get a replacement or my money back?";
  console.log(`User: ${userPrompt}\n`);

  // Initial execution run
  let result = await app.invoke(
    { messages: [new HumanMessage(userPrompt)] },
    config
  );

  // Inspect state after step
  let currentState = await app.getState(config);

  // Check if graph paused on breakpoint
  while (currentState.next && currentState.next.includes("tools")) {
    const lastMessage = currentState.values.messages[
      currentState.values.messages.length - 1
    ] as AIMessage;

    const pendingCalls = lastMessage.tool_calls || [];
    const isMutation = pendingCalls.some((c) => c.name === "create_refund");

    if (isMutation) {
      console.log("\n⚠️  [GATEWAY INTERRUPT] Critical action flagged for human authorization:");
      console.log(JSON.stringify(pendingCalls, null, 2));

      const answer = await rl.question(
        "\nManager approval required: Approve refund execution? (yes/no): "
      );

      if (answer.trim().toLowerCase() === "yes") {
        console.log("Approval granted. Resuming workflow from checkpoint...\n");
        // Resume from checkpoint by passing null state update
        result = await app.invoke(null, config);
      } else {
        console.log("Refund rejected by manager. Injecting rejection into state...\n");
        // Update state to redirect agent
        await app.updateState(
          config,
          {
            messages: [
              new HumanMessage("Supervisor note: Refund denied. Offer a store credit voucher instead."),
            ],
          },
          "agent"
        );
        result = await app.invoke(null, config);
      }
    } else {
      // Safe read-only tool (e.g., lookup_order, check_inventory), resume automatically
      result = await app.invoke(null, config);
    }

    currentState = await app.getState(config);
  }

  // Print final synthesized answer
  const finalMessage = currentState.values.messages[
    currentState.values.messages.length - 1
  ];
  console.log("\nFinal Agent Response:\n", finalMessage.content);

  rl.close();
}

runSession().catch(console.error);