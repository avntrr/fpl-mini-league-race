/**
 * Remotion Root — registers the Race composition.
 * Duration is calculated dynamically from inputProps (totalGws × stepsPerGw + hold).
 */
import React from "react";
import { Composition } from "remotion";
import { Race, RaceProps } from "./Race";

const STEPS_TABLE: Record<number, number[]> = {
  30: [26, 13, 5],
  60: [52, 26, 10],
};

const DEFAULT_PROPS: RaceProps = {
  data: {
    leagueName: "FPL League",
    totalGws: 38,
    managers: [],
    scores: [],
    gwScores: [],
  },
  theme: "dark",
  speed: 0,
  topN: 10,
  fps: 30,
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Race"
      component={Race}
      // Overridden by calculateMetadata at render time
      durationInFrames={30}
      fps={30}
      width={540}
      height={960}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }: { props: RaceProps }) => {
        const fps       = props.fps ?? 30;
        const speed     = props.speed ?? 0;
        const totalGws  = props.data?.totalGws ?? 38;
        const steps     = (STEPS_TABLE[fps] ?? STEPS_TABLE[30])[Math.max(0, Math.min(speed, 2))];
        return {
          durationInFrames: totalGws * steps + 45,
          fps,
        };
      }}
    />
  );
};
