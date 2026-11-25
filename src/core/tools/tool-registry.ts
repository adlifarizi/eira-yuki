import { IncomingMessage, UserRole } from '../types';
import { CoreTool, ToolCall, ToolDefinition, ToolExecutionResult } from './types';

export class ToolRegistry {
  private tools = new Map<string, CoreTool>();

  /**
   * Registers a single core tool into the registry.
   */
  register(tool: CoreTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Registers an array of core tools into the registry in batch.
   */
  registerAll(tools: CoreTool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /** Retrieves a registered tool by its unique name. */
  getTool(name: string): CoreTool | undefined {
    return this.tools.get(name);
  }

  /** Returns all registered tools. */
  getAllTools(): CoreTool[] {
    return Array.from(this.tools.values());
  }

  /** Returns tools accessible to the specified user role. */
  getToolsForRole(role: UserRole): CoreTool[] {
    return this.getAllTools().filter((tool) => {
      if (tool.ownerOnly && role !== 'owner') {
        return false;
      }
      return true;
    });
  }

  getToolDefinitionsForRole(role: UserRole): ToolDefinition[] {
    const tools = this.getToolsForRole(role);
    if (tools.length === 0) return [];

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** Executes a single tool by name after validating existence and role authorization. */
  async executeTool(name: string, params: Record<string, any>, context: IncomingMessage): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" is not registered.`);
    }

    if (tool.ownerOnly && context.role !== 'owner') {
      throw new Error(`Access denied: Tool "${name}" can only be used by the Owner.`);
    }

    return await tool.execute(params, context);
  }

  /** Executes multiple tool calls concurrently and returns their results in order. */
  async executeToolsParallel(
    calls: ToolCall[],
    context: IncomingMessage
  ): Promise<ToolExecutionResult[]> {
    if (!calls || calls.length === 0) return [];

    return Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.executeTool(call.name, call.args, context);
          return { toolName: call.name, result };
        } catch (error: any) {
          const errMsg = error?.message || 'Tool execution error';
          return { toolName: call.name, result: { error: errMsg }, error: errMsg };
        }
      })
    );
  }
}
