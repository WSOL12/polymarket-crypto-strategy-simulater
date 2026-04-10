type Props = {
  timeframe: string;
  symbol: string;
  onTimeframeChange: (v: string) => void;
  onSymbolChange: (v: string) => void;
  streaming: boolean;
  onStart: () => void;
  onStop: () => void;
  wsStreamNote: string;
};

export function DashboardForm(props: Props) {
  return (
    <div className="dashForms">
      <form className="formPanel" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Market</legend>
          <div className="formGrid formGridMarketRow">
            <label htmlFor="input-timeframe">
              Timeframe
              <select
                id="input-timeframe"
                name="timeframe"
                value={props.timeframe}
                onChange={(e) => props.onTimeframeChange(e.target.value)}
              >
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
              </select>
            </label>
            <label htmlFor="input-symbol">
              Symbol
              <select
                id="input-symbol"
                name="symbol"
                value={props.symbol}
                onChange={(e) => props.onSymbolChange(e.target.value)}
              >
                <option value="BTC">BTC</option>
                <option value="ETH">ETH</option>
                <option value="SOL">SOL</option>
              </select>
            </label>
            <label htmlFor="input-stream-note" className="formGridMarketNote">
              Server note
              <input
                id="input-stream-note"
                name="streamNote"
                type="text"
                readOnly
                value={props.wsStreamNote}
                placeholder="—"
                title={props.wsStreamNote || undefined}
              />
            </label>
          </div>
          <div className="formActions">
            <button
              type="button"
              className="btn btnStart"
              disabled={props.streaming}
              onClick={props.onStart}
            >
              Start live
            </button>
            <button
              type="button"
              className="btn btnStop"
              disabled={!props.streaming}
              onClick={props.onStop}
            >
              Stop
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
