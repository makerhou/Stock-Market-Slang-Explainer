/**
 * Aho-Corasick 多模式匹配自动机（架构 §2.4 方案 D / backend-implementation §3.2）。
 * 同构包，零依赖，可在浏览器/Node/Edge 运行。
 * collect() 一次遍历输出全部候选 span（含被更长匹配包含的短匹配），
 * 由 decide.ts 的裁决层做「最长优先 + 重叠去重 + 词边界检查」。
 */

export interface AcSpan {
  /** 命中的归一化别名串（即自动机的 pattern） */
  key: string;
  /** 归一化文本中的起点（含） */
  start: number;
  /** 归一化文本中的终点（不含） */
  end: number;
}

interface AcNode {
  goto: Map<string, number>;
  fail: number;
  /** 该节点（及其 fail 闭包）上的所有匹配 pattern */
  out: string[];
}

export class AhoCorasick {
  private nodes: AcNode[] = [];

  constructor(patterns: string[]) {
    this.nodes.push({ goto: new Map(), fail: 0, out: [] });
    // 建树
    for (const p of patterns) {
      let cur = 0;
      for (const ch of p) {
        let nxt = this.node(cur).goto.get(ch);
        if (nxt === undefined) {
          nxt = this.nodes.length;
          this.nodes.push({ goto: new Map(), fail: 0, out: [] });
          this.node(cur).goto.set(ch, nxt);
        }
        cur = nxt;
      }
      const node = this.node(cur);
      if (!node.out.includes(p)) node.out.push(p);
    }
    this.buildFail();
  }

  /** 节点访问收窄：index 恒为内部构造产生，必然存在 */
  private node(index: number): AcNode {
    const n = this.nodes[index];
    if (!n) throw new Error(`AhoCorasick: invalid node index ${index}`);
    return n;
  }

  private buildFail(): void {
    const queue: number[] = [];
    for (const [ch, child] of this.node(0).goto) {
      this.node(child).fail = 0;
      queue.push(child);
      void ch;
    }
    while (queue.length) {
      const u = queue.shift();
      if (u === undefined) break;
      for (const [ch, v] of this.node(u).goto) {
        let f = this.node(u).fail;
        while (f !== 0 && !this.node(f).goto.has(ch)) f = this.node(f).fail;
        const g = this.node(f).goto.get(ch);
        this.node(v).fail = g === undefined ? 0 : g;
        // fail 闭包传递
        this.node(v).out = this.node(v).out.concat(this.node(this.node(v).fail).out);
        queue.push(v);
      }
    }
  }

  private nextState(node: number, ch: string): number {
    let cur = node;
    while (cur !== 0 && !this.node(cur).goto.has(ch)) cur = this.node(cur).fail;
    const g = this.node(cur).goto.get(ch);
    return g === undefined ? 0 : g;
  }

  /** 一次遍历收集全部 span（含更短匹配被更长匹配包含的情况） */
  collect(text: string): AcSpan[] {
    const spans: AcSpan[] = [];
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === undefined) continue;
      state = this.nextState(state, ch);
      const outs = this.node(state).out;
      for (const p of outs) {
        spans.push({ key: p, start: i - p.length + 1, end: i + 1 });
      }
    }
    // 去重（相同 key + 起点 + 终点）
    const seen = new Set<string>();
    const dedup: AcSpan[] = [];
    for (const s of spans) {
      const k = `${s.key}@${s.start}:${s.end}`;
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(s);
      }
    }
    return dedup;
  }
}
