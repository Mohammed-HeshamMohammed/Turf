import { useEffect, useRef, useState } from "react";
import { Icon } from "./components.jsx";
import { MotionToggle } from "./motion.jsx";
const steps = [
  ["Import lists", "Bring your property records into one workspace."],
  ["Review numbers", "Review and rank the phone evidence you already have."],
  ["Prepare calls", "Keep context close. Live calling is not available yet."],
  ["Track follow-ups", "Record outcomes and give the next step an owner."],
];
export function Workflow() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(true);
  useEffect(() => {
    const update = () => setActive(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    if (typeof IntersectionObserver === "undefined") setVisible(true);
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            ([entry]) => setVisible(entry.isIntersecting),
            { threshold: 0.1 },
          )
        : null;
    observer?.observe(ref.current);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <section
      ref={ref}
      className="studio-workflow"
      id="workflow"
      aria-label="The outreach workflow"
      data-running={visible && active}
    >
      <div className="workflow-caption">
        <p className="studio-label">
          From the first record to the next conversation
        </p>
        <MotionToggle />
      </div>
      <ol role="list">
        {steps.map(([title, text], index) => (
          <li key={title} style={{ "--flow-step": index }}>
            <span className="studio-label" aria-hidden="true">
              0{index + 1}
            </span>
            <div>
              <h2>{title}</h2>
              <p>{text}</p>
            </div>
            {index < steps.length - 1 && (
              <span className="workflow-connector" aria-hidden="true">
                <Icon name="ArrowRight" size={18} />
                <Icon name="ArrowRight" size={18} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
