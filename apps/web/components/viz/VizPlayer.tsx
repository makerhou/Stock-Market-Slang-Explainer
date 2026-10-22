import type { ComponentType } from "react";
import type { TermViz, VizType } from "@jargon/contracts";

import { PriceChangeBars, CandleBuilder, MarketMood, VolumeRatio, MarketCapBar } from "./viz-price";
import { GDPStack, CPIBasket, InventoryClear, PoolDilution, UnlockPressure } from "./viz-macro";
import { PEScale, ProfitLossScale, DividendSplit, ExRightAdjust, TurnoverPie } from "./viz-finance";
import { CrossLines, Oscillator } from "./viz-indicators";
import { MoneyFlow, LongShortSeesaw } from "./viz-fund";
import { IpoLottery, BreakIssue, TrapScale, RiskLadder, ConvertibleScale, HaltClock } from "./viz-trading";
import { IndexTower, CircuitBreaker, PrePostMarket, EarningsSeason, AdrBridge, OptionsLadder } from "./viz-us";
import { LeverageWheel, GreyMarket, HkTypesCompare } from "./viz-hk";
import { GaugeBar } from "./viz-gauge";

const REGISTRY: Record<VizType, ComponentType<{ config?: Record<string, unknown> }>> = {
  // 原有 19 个
  PriceChangeBars,
  CandleBuilder,
  MarketMood,
  VolumeRatio,
  MarketCapBar,
  GDPStack,
  CPIBasket,
  InventoryClear,
  PoolDilution,
  UnlockPressure,
  PEScale,
  ProfitLossScale,
  DividendSplit,
  ExRightAdjust,
  TurnoverPie,
  CrossLines,
  Oscillator,
  MoneyFlow,
  LongShortSeesaw,
  // 中美港股扩充（M10）
  IpoLottery,
  BreakIssue,
  TrapScale,
  RiskLadder,
  ConvertibleScale,
  HaltClock,
  IndexTower,
  CircuitBreaker,
  PrePostMarket,
  EarningsSeason,
  AdrBridge,
  OptionsLadder,
  LeverageWheel,
  GreyMarket,
  HkTypesCompare,
  GaugeBar,
};

/** 词条详情页的「看图秒懂」区块：按 viz.type 渲染对应互动组件 */
export function VizPlayer({ viz }: { viz?: TermViz | null }) {
  if (!viz) return null;
  const Comp = REGISTRY[viz.type];
  if (!Comp) return null;
  return <Comp config={viz.config} />;
}
