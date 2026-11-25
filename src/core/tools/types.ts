import { IncomingMessage, ToolParameterSchema, ToolDefinition, ToolCall, ToolResult } from '../types';

export type { ToolParameterSchema, ToolDefinition, ToolCall, ToolResult };

/**
 * Executable tool implementation registered in the ToolRegistry.
 * Extends ToolDefinition with role authorization and runtime execution logic.
 */
export interface CoreTool extends ToolDefinition {
  /** If true, only the primary owner can invoke this tool. Guests are denied access. */
  ownerOnly: boolean;
  /**
   * Optional operational directive or behavioral constraint for the LLM when this tool is available.
   * Dynamically injected into the system prompt invariants.
   */
  operationalDirective?: string;
  /**
   * Executes the tool with the arguments provided by the model and the conversation context.
   */
  execute: (params: Record<string, any>, context: IncomingMessage) => Promise<any>;
}

/**
 * Result record from parallel tool execution within the ToolRegistry.
 */
export interface ToolExecutionResult {
  /** Name of the executed tool. */
  toolName: string;
  /** Execution output payload returned by the tool. */
  result: any;
  /** Error message if tool execution threw an exception. */
  error?: string;
}
