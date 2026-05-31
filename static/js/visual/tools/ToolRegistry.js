export class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }

    add(tool) { this.tools.set(tool.id, tool); }
    remove(id) { return this.tools.delete(id); }
    get(id) { return this.tools.get(id); }
    has(id) { return this.tools.has(id); }
    list() { return [...this.tools.values()]; }
}
