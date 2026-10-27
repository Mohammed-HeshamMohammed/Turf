import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { CALL_DAYS, CALL_TREND } from "./data.js";
import { DataTable, useTableView } from "./ui.jsx";

function IntervalTooltip({ active, payload }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="interval-tooltip">
      <strong>
        {point.day}, {point.date}
      </strong>
      <span>{point.time}</span>
      <div>
        <i className="key-dot peach" />
        <span>Calls made</span>
        <b>{point.calls}</b>
      </div>
      <div>
        <i className="key-dot black" />
        <span>Reached a person</span>
        <b>{point.reached}</b>
      </div>
      <small>{Math.round((point.reached / Math.max(point.calls, 1)) * 100)}% reached · illustrative interval</small>
    </div>
  );
}
export function CallActivityChart() {
  const table = useTableView(
    CALL_TREND,
    {
      day: { value: point => point.slot },
      time: { value: point => point.slot },
      calls: { value: point => point.calls },
      reached: { value: point => point.reached },
    },
    "call-intervals",
  );
  return (
    <>
      <div className="chart-key">
        <span>
          <i className="key-dot peach" />
          Calls made
        </span>
        <span>
          <i className="key-dot black" />
          Reached a person
        </span>
        <small>6 points per day · 2-hour intervals</small>
      </div>
      <div
        className="chart-container"
        role="img"
        aria-label="Illustrative two-hour call activity across seven days. Hover a point or use arrow keys for interval details."
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart accessibilityLayer data={CALL_TREND} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid vertical={false} stroke="#dedede" />
            <XAxis
              type="number"
              dataKey="slot"
              domain={[8, 162]}
              ticks={CALL_DAYS.map((_, index) => index * 24 + 13)}
              tickFormatter={value => CALL_DAYS[Math.floor(value / 24)]}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#6f6f6f", fontSize: 12 }}
              dy={8}
            />
            <YAxis width={25} allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "#7b7b7b", fontSize: 10 }} />
            <Tooltip content={<IntervalTooltip />} cursor={{ stroke: "#8f8f8f", strokeDasharray: "3 4" }} isAnimationActive={false} />
            <Area
              type="monotone"
              dataKey="calls"
              name="Calls made"
              stroke="#d7a66e"
              fill="#fbdfc2"
              strokeWidth={2}
              fillOpacity={0.5}
              dot={{ r: 2.5, fill: "#f7f7f7", stroke: "#d7a66e", strokeWidth: 1.3 }}
              activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="reached"
              name="Reached a person"
              stroke="#262626"
              fill="#bcbcbc"
              strokeWidth={2}
              fillOpacity={0.12}
              dot={{ r: 2.5, fill: "#f7f7f7", stroke: "#262626", strokeWidth: 1.3 }}
              activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-help">Hover between the day labels for time, calls, and reach rate.</p>
      <details className="chart-data">
        <summary>View all 42 sample intervals</summary>
        <DataTable
          view={table}
          rowKey={point => point.slot}
          columns={[
            {
              id: "day",
              label: "Day",
              cell: point => (
                <>
                  {point.day}, {point.date}
                </>
              ),
            },
            { id: "time", label: "Time", cell: point => point.time },
            { id: "calls", label: "Calls", cell: point => point.calls },
            { id: "reached", label: "Reached", cell: point => point.reached },
          ]}
        />
      </details>
    </>
  );
}
