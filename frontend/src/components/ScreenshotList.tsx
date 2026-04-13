import type { ScreenshotRow } from "../api";

type Props = {
  rows: ScreenshotRow[];
};

export function ScreenshotList({ rows }: Props) {
  return (
    <div className="panel screenshotPanel">
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
                  <th>Window / file</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.timeframe}</td>
                    <td>{r.symbol}</td>
                    <td className="screenshotLabelEt">
                      <div className="screenshotLabelMain">
                        {r.label_et || r.file_name || r.window_slug}
                      </div>
                      {r.file_name ? (
                        <div className="screenshotLabelFile" title={r.file_path}>
                          {r.file_name}
                        </div>
                      ) : null}
                    </td>
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
