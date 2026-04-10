import type { ScreenshotRow } from "../api";

type Props = {
  rows: ScreenshotRow[];
};

export function ScreenshotList({ rows }: Props) {
  return (
    <div className="panel">
      <form className="formPanel" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Screenshots ({rows.length})</legend>
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Timeframe</th>
                  <th>Symbol</th>
                  <th>Ref</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.timeframe}</td>
                    <td>{r.symbol}</td>
                    <td>{r.window_slug}</td>
                    <td>
                      <a
                        href={`/api/screenshots/${r.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
