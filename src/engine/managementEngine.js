'use strict';

/**
 * Trade management engine.
 *
 * Describes what to do after entry. It is intentionally deterministic:
 * profit-taking and trailing rules are tied to the risk plan and the
 * structural invalidation, not to a confidence score.
 */

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function buildManagementPlan({ strategy, risk, entry, regime, spot }) {
  if (!risk || risk.status === 'UNAVAILABLE' || risk.status === 'CONDITIONAL') {
    return {
      status: 'CONDITIONAL',
      action: 'NO_ACTION',
      reason: risk?.reason || 'Risk plan unavailable.'
    };
  }

  const direction = regime?.direction || 'NEUTRAL';
  const s = n(spot);

  if (strategy === 'BEAR_CALL_SPREAD' || strategy === 'BULL_PUT_SPREAD' || strategy === 'IRON_CONDOR') {
    const be = risk.breakeven || {};
    const isCondor = strategy === 'IRON_CONDOR';

    return {
      status: 'READY',
      action: entry?.status === 'READY_TO_ENTER' ? 'ENTER_IF_PREMIUM_ZONE_HOLDS' : 'WAIT',
      profitTaking: {
        target1: 'Take partial profit at risk.target1.',
        target2: 'Close the remaining position at risk.target2.'
      },
      trailing: {
        afterTarget1: 'Move stop to protect at least the remaining unrealised profit; do not widen the original stop.',
        condition: 'Trail only in the direction of the active structural thesis.'
      },
      adjustment: isCondor
        ? [
            'If spot approaches either short strike, reassess the range thesis before adjusting.',
            'Do not add risk after a directional break.'
          ]
        : [
            'If spot approaches the short strike, reassess the credit thesis.',
            'Do not widen the spread or add size to rescue a broken thesis.'
          ],
      thesisInvalidation: isCondor
        ? 'Underlying exits the short-strike range with directional confirmation.'
        : direction.includes('BEAR')
          ? 'Underlying sustains above the short call/breakeven structure.'
          : 'Underlying sustains below the short put/breakeven structure.',
      timeExit: 'Exit/reassess when maxHoldMinutes is reached; do not extend solely because the position is losing.',
      snapshot: { spot: s, breakeven: be }
    };
  }

  if (strategy === 'BULL_CALL_SPREAD' || strategy === 'BEAR_PUT_SPREAD') {
    return {
      status:'READY',action:entry?.status==='READY_TO_ENTER'?'ENTER_IF_PREMIUM_ZONE_HOLDS':'WAIT',
      profitTaking:{target1:'Take partial profit at risk.target1.',target2:'Close remaining spread at risk.target2.'},
      trailing:{afterTarget1:'Protect the remaining debit; never widen the initial stop.',condition:'Continue only while underlying structure supports the directional thesis.'},
      adjustment:['Do not average down a losing debit spread.','Exit on underlying invalidation even if spread stop has not printed.'],
      thesisInvalidation:strategy==='BULL_CALL_SPREAD'?'Underlying loses reclaimed bullish structure.':'Underlying reclaims broken bearish structure.',
      timeExit:'Exit/reassess when maxHoldMinutes is reached.',snapshot:{spot:s}
    };
  }

  if (strategy === 'LONG_CALL' || strategy === 'LONG_PUT') {
    return {
      status: 'READY',
      action: entry?.status === 'READY_TO_ENTER' ? 'ENTER_IF_PREMIUM_ZONE_HOLDS' : 'WAIT',
      profitTaking: {
        target1: 'Take partial profit at risk.target1.',
        target2: 'Close the remaining position at risk.target2.'
      },
      trailing: {
        afterTarget1: 'Move stop behind the most recent valid structural level; never widen the initial risk.',
        condition: 'Continue trailing only while the directional thesis and underlying structure remain intact.'
      },
      adjustment: [
        'Do not average down after the underlying invalidation is breached.',
        'If momentum disappears before target1, reassess rather than automatically extending the hold.'
      ],
      thesisInvalidation: strategy === 'LONG_CALL'
        ? 'Underlying loses the support/reclaim structure used for entry.'
        : 'Underlying reclaims the resistance/breakdown structure used for entry.',
      timeExit: 'Exit/reassess when maxHoldMinutes is reached.',
      snapshot: { spot: s }
    };
  }

  return {
    status: 'CONDITIONAL',
    action: 'NO_ACTION',
    reason: 'Strategy has no management model.'
  };
}

module.exports = { buildManagementPlan };
