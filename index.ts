/**
 * pi-loop：Pi 无限自我迭代扩展
 *
 * 命令：
 *   /loop [目标]    激活循环：空闲时立即开始下一轮，运行中则在本轮结束后接管
 *   /loop-off       里程碑停止：当前轮自然结束后停止；空闲时立即停止
 *   /loop-off-now   立即停止：中止当前运行并清除循环状态
 *
 * 设计契约（修改前先读 README 的「关键认知」）：
 *   - 停止条件只有 /loop-off 与 /loop-off-now；模型自述、报错、中断都不算
 *   - 四道点火机制：agent_before_settle、agent_settled、看门狗、session_start 恢复
 *   - 上下文只追加、不改写历史（前缀缓存友好）；压缩后清理旧指令，循环关闭后全部移除
 *   - 循环状态用 pi.appendEntry 写入会话；进程内变量只是缓存
 *   - 仅依赖宿主提供包，保持单文件、无构建步骤
 *
 * 激活状态通过 ctx.ui.setStatus 显示在底部状态栏。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const STATUS_KEY = "pi-loop";
const ENTRY_TYPE = "pi-loop-state";
const TICK_TYPE = "pi-loop-tick";

const DEFAULT_GOAL = "持续推进当前项目：完成或改进当前最高价值的未完成工作，并自行验证结果。";
const ERROR_BACKOFF_START_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 60_000;
const RESTART_MIN_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const SESSION_RESUME_DELAY_MS = 1_500;
const WATCHDOG_INTERVAL_MS = 15_000;

type LoopPhase = "off" | "running" | "stopping";
type TickOutcome = "completed" | "aborted" | "error" | "interrupted" | undefined;

interface PersistedState {
  phase: LoopPhase;
  goal: string;
  iteration: number;
}

interface TickDetails {
  iteration: number;
  goal: string;
  stallStreak: number;
}

interface TickMessage {
  customType: string;
  content: string;
  display: boolean;
  details: TickDetails;
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const typed = block as { type?: string; text?: string } | undefined;
        return typed?.type === "text" ? (typed.text ?? "") : "[non-text]";
      })
      .join("");
  }
  return "";
}

export default function piLoop(pi: ExtensionAPI): void {
  let phase: LoopPhase = "off";
  let goal = DEFAULT_GOAL;
  let iteration = 0;
  let stallStreak = 0;
  /** 本轮是否调用过工具：决定迭代是否真实 */
  let usedToolThisRound = false;
  /** 本轮迭代指令是否已注入：决定是否评估停滞 */
  let tickInjected = false;
  // 点火去重：三道点火机制可能同时命中，以下标志保证同一时刻只有一次点火
  /** 已结束运行但循环仍在激活：等待重新点火 */
  let restartArmed = false;
  let errorBackoffMs = 0;
  let restartDelayMs = 0;
  /** 当前是否有运行在执行（乐观置位，避免看门狗重复点火） */
  let runActive = false;
  /** 压缩会重写历史、前缀缓存必然失效：借压缩后的第一次请求清理旧迭代指令 */
  let trimTicksAfterCompact = false;
  let disposed = false;
  let pendingRestart: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function isTick(message: unknown): boolean {
    const candidate = message as { role?: string; customType?: string } | undefined;
    return candidate?.role === "custom" && candidate.customType === TICK_TYPE;
  }

  function persist(): void {
    const state: PersistedState = { phase, goal, iteration };
    pi.appendEntry(ENTRY_TYPE, state);
  }

  function updateStatus(ctx: ExtensionContext): void {
    const theme = ctx.ui.theme;
    if (phase === "off") {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const label = theme.fg("accent", "∞ loop") + theme.fg("dim", ` #${iteration}`);
    if (phase === "stopping") {
      ctx.ui.setStatus(STATUS_KEY, label + theme.fg("warning", " 收尾中…"));
      return;
    }
    const flags =
      (restartArmed ? theme.fg("accent", " ↻") : "") +
      (stallStreak > 0 ? theme.fg("warning", " ⚠") : "");
    ctx.ui.setStatus(STATUS_KEY, label + flags);
  }

  function buildTickContent(outcome: TickOutcome): string {
    const lines = [
      `[PI-LOOP ACTIVE] 第 ${iteration} 轮自我迭代：这是一个不会自行停止的外部循环。`,
      "",
      "1. 立即开始当前最高价值的下一步工作并直接动手；不征求许可、不复述计划、不以提问结束。",
      "2. 本轮必须有真实产出（文件修改、命令执行、验证结果），纯文字回复不算迭代。",
      "3. 完成后自行验证（测试、构建、运行），简短记录结果和新发现，然后继续下一轮。",
      "4. 当前目标完成后，主动寻找下一个更高价值的改进点继续推进。",
      "5. 只有外部指令 /loop-off 或 /loop-off-now 才能结束循环；不自行收尾，也不询问是否继续。",
      "",
      `长期目标：${goal}`,
    ];
    if (stallStreak > 0) {
      lines.push("", `⚠ 最近连续 ${stallStreak} 轮没有工具调用，本轮必须执行真实动作。`);
    }
    if (outcome === "error") {
      lines.push("", "⚠ 上一轮模型请求出错：先诊断原因并规避该错误，再继续推进目标。");
    }
    if (outcome === "interrupted") {
      lines.push("", "⚠ 上一轮被外部中断（循环并未关闭）：从中断处继续，不等待确认。");
    }
    return lines.join("\n");
  }

  /** 开始新一轮：推进计数、更新停滞统计，并返回本轮注入内容。 */
  function beginRound(outcome: TickOutcome, evaluateStall: boolean): TickMessage {
    iteration += 1;
    restartArmed = false;
    if (evaluateStall) {
      if (usedToolThisRound) stallStreak = 0;
      else stallStreak += 1;
    }
    usedToolThisRound = false;
    tickInjected = true;
    persist();
    return {
      customType: TICK_TYPE,
      content: buildTickContent(outcome),
      display: true,
      details: { iteration, goal, stallStreak },
    };
  }

  /** 取消待执行的重新点火。 */
  function cancelRestart(): void {
    if (pendingRestart !== undefined) {
      clearTimeout(pendingRestart);
      pendingRestart = undefined;
    }
    restartArmed = false;
  }

  /** 运行已结束或尚未开始：安排一次自动点火，直到用户显式停止。 */
  function fireRestart(ctx: ExtensionContext, outcome: TickOutcome, delayMs: number): void {
    if (disposed || phase !== "running" || pendingRestart !== undefined) return;
    restartArmed = true;
    runActive = true; // 乐观置位，避免看门狗重复点火
    updateStatus(ctx);
    pendingRestart = setTimeout(() => {
      pendingRestart = undefined;
      if (disposed || phase !== "running") {
        restartArmed = false;
        if (!disposed) updateStatus(ctx);
        return;
      }
      // 用户输入优先：退避期间用户已开始新运行或有排队消息时本轮不点火，
      // 否则迭代指令会以 steer 插进用户的运行；用户运行结束时会在结算点自然续上
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        restartArmed = false;
        runActive = !ctx.isIdle();
        updateStatus(ctx);
        return;
      }
      const tick = beginRound(outcome, false);
      runActive = true;
      updateStatus(ctx);
      pi.sendMessage(tick, { triggerTurn: true });
    }, delayMs);
  }

  function stopLoop(ctx: ExtensionContext, reason: string): void {
    phase = "off";
    cancelRestart();
    updateStatus(ctx);
    persist();
    ctx.ui.notify(`pi-loop 已停止（完成 ${iteration} 轮）：${reason}`, "info");
  }

  // [终端显示] 把冗长的迭代指令折叠成一行

  pi.registerMessageRenderer(TICK_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details as TickDetails | undefined;
    const suffix = details && details.stallStreak > 0 ? `（已停滞 ${details.stallStreak} 轮）` : "";
    let label =
      theme.fg("accent", "∞ loop") +
      theme.fg("dim", ` #${details?.iteration ?? 0} `) +
      theme.fg("muted", `自我迭代${suffix}`);
    if (expanded) {
      label += "\n" + theme.fg("dim", toText(message.content));
    }
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(label, 0, 0));
    return box;
  });

  // [命令]

  pi.registerCommand("loop", {
    description: "激活无限自我迭代循环（可带目标：/loop 目标描述）",
    handler: async (args, ctx) => {
      const requestedGoal = args.trim();
      if (requestedGoal) goal = requestedGoal;

      const wasRunning = phase === "running" && !restartArmed;
      phase = "running";
      errorBackoffMs = 0;
      if (!wasRunning) {
        cancelRestart();
        stallStreak = 0;
        usedToolThisRound = false;
        tickInjected = false;
      }
      updateStatus(ctx);
      persist();

      if (wasRunning) {
        ctx.ui.notify(
          requestedGoal ? `pi-loop 目标已更新：${goal}` : `pi-loop 已在运行（第 ${iteration} 轮）`,
          "info",
        );
        return;
      }

      if (ctx.isIdle()) {
        const tick = beginRound(undefined, false);
        runActive = true;
        updateStatus(ctx);
        pi.sendMessage(tick, { triggerTurn: true });
        ctx.ui.notify(
          `pi-loop 已激活（第 ${iteration} 轮）：${goal}\n停止：/loop-off（里程碑）、/loop-off-now（立即）`,
          "info",
        );
      } else {
        ctx.ui.notify(`pi-loop 已激活，将在本轮结束时接管：${goal}`, "info");
      }
    },
  });

  pi.registerCommand("loop-off", {
    description: "在下一个里程碑（当前轮自然结束）停止循环",
    handler: async (_args, ctx) => {
      if (phase === "off") {
        ctx.ui.notify("pi-loop 当前未激活", "info");
        return;
      }
      if (ctx.isIdle()) {
        stopLoop(ctx, "当前空闲");
        return;
      }
      phase = "stopping";
      cancelRestart();
      updateStatus(ctx);
      persist();
      ctx.ui.notify(`pi-loop 将在本轮里程碑处停止（当前第 ${iteration} 轮）`, "warning");
    },
  });

  pi.registerCommand("loop-off-now", {
    description: "立即中止当前运行并停止循环",
    handler: async (_args, ctx) => {
      if (phase === "off") {
        ctx.ui.notify("pi-loop 当前未激活", "info");
        return;
      }
      const streaming = !ctx.isIdle();
      phase = "off";
      cancelRestart();
      updateStatus(ctx);
      persist();
      if (streaming) ctx.abort();
      ctx.ui.notify(`pi-loop 已立即停止（已完成 ${iteration} 轮）`, "warning");
    },
  });

  // [事件]

  pi.on("agent_start", async () => {
    runActive = true;
    restartArmed = false;
    restartDelayMs = 0;
  });

  // 本轮是否真的调用过工具（纯文字回复不算迭代）
  pi.on("tool_execution_start", async () => {
    usedToolThisRound = true;
  });

  pi.on("session_compact", async () => {
    trimTicksAfterCompact = true;
  });

  // 上下文只追加、不改写历史：删除任意一条历史消息都会让其后缀的前缀缓存全部失效
  pi.on("context", async (event) => {
    const ticks = event.messages.filter(isTick);
    if (ticks.length === 0) return;

    if (phase === "off") {
      trimTicksAfterCompact = false;
      return { messages: event.messages.filter((message) => !isTick(message)) };
    }

    // 压缩改写历史后缓存本就要重建，此时清理旧指令不产生额外代价
    if (!trimTicksAfterCompact) return;
    trimTicksAfterCompact = false;
    const keep = ticks[ticks.length - 1];
    return { messages: event.messages.filter((message) => !isTick(message) || message === keep) };
  });

  // 核心：每次 agent 即将结束（模型自然停下）时，若无显式停止指令就继续下一轮
  pi.on("agent_before_settle", async (event, ctx) => {
    if (phase === "off") return;

    if (phase === "stopping") {
      const rounds = iteration;
      phase = "off";
      cancelRestart();
      updateStatus(ctx);
      persist();
      ctx.ui.notify(`pi-loop 已在里程碑处停止（共 ${rounds} 轮）`, "info");
      return;
    }

    if (event.outcome === "aborted") {
      // 中断不能停止循环：本轮不继续，agent_settled 会立刻重新点火
      return;
    }

    if (event.outcome === "error") {
      errorBackoffMs =
        errorBackoffMs === 0
          ? ERROR_BACKOFF_START_MS
          : Math.min(errorBackoffMs * 2, ERROR_BACKOFF_MAX_MS);
      await sleep(errorBackoffMs);
      if (phase !== "running") return; // 退避期间被 /loop-off-now 停止
    } else {
      errorBackoffMs = 0;
    }

    const tick = beginRound(event.outcome === "error" ? "error" : undefined, tickInjected);
    runActive = true;
    updateStatus(ctx);
    return {
      continue: true,
      entries: [{ type: "custom_message", ...tick }],
    };
  });

  // 运行彻底结束而循环仍激活（被中断、异常结束、边界无法继续）：自动重新点火
  pi.on("agent_settled", async (_event, ctx) => {
    runActive = false;
    if (disposed || phase !== "running") return;
    const delay = restartDelayMs <= 0 ? RESTART_MIN_DELAY_MS : restartDelayMs;
    restartDelayMs = Math.min(Math.max(delay * 2, RESTART_MIN_DELAY_MS), RESTART_MAX_DELAY_MS);
    fireRestart(ctx, "interrupted", delay);
  });

  // 恢复会话时还原循环状态；仍在激活则自动继续迭代
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const state = entry.data as Partial<PersistedState> | undefined;
      phase = state?.phase ?? "off";
      goal = state?.goal?.trim() ? state.goal : DEFAULT_GOAL;
      iteration = typeof state?.iteration === "number" ? state.iteration : 0;
      break;
    }

    updateStatus(ctx);
    if (phase === "running") {
      ctx.ui.notify(`pi-loop 已恢复（第 ${iteration} 轮）；/loop-off 停止`, "info");
      // 延迟点火：避免抢占用户启动时刚提交的第一条消息
      fireRestart(ctx, undefined, SESSION_RESUME_DELAY_MS);
    }

    if (watchdog !== undefined) clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (disposed || phase !== "running" || runActive || restartArmed) return;
      fireRestart(ctx, "interrupted", 0);
    }, WATCHDOG_INTERVAL_MS);
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    cancelRestart();
    if (watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  });
}
