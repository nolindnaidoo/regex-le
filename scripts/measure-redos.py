"""Ground truth by measurement: does this pattern blow up on adversarial input?"""
import re, sys, time, json, signal

def timed(pattern, text, budget=2.0):
    """Seconds to match, or budget+ if it exceeds it (SIGALRM)."""
    compiled = re.compile(pattern)
    def bail(*_): raise TimeoutError
    signal.signal(signal.SIGALRM, bail)
    signal.setitimer(signal.ITIMER_REAL, budget)
    start = time.perf_counter()
    try:
        compiled.search(text)
        return time.perf_counter() - start
    except TimeoutError:
        return float("inf")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)

def attack_chars(pattern):
    """Characters worth repeating, taken from the pattern itself."""
    seed = set()
    for m in re.finditer(r"\[([^\]]+)\]", pattern):
        body = m.group(1)
        for ch in "abcxyz019-_. ":
            if re.match(r"[" + body + r"]", ch) if body else False:
                seed.add(ch)
    for ch in re.findall(r"[A-Za-z0-9_\-]", pattern):
        seed.add(ch)
    seed.update({"a", "0", "-", "_", " "})
    return sorted(seed)[:8]

def classify(pattern, budget=2.0):
    """exponential | linear, by growth across n, plus the worst timing seen."""
    worst = 0.0
    for ch in attack_chars(pattern):
        for suffix in ("!", "\x00", ""):
            times = []
            for n in (14, 18, 22, 26, 30):
                t = timed(pattern, ch * n + suffix, budget)
                times.append(t)
                if t == float("inf"):
                    return "exponential", float("inf"), f"{ch!r}*{n}+{suffix!r}"
            worst = max(worst, times[-1])
            # Doubling n should not multiply time by ~16 for a linear pattern.
            if times[0] > 0 and times[-1] / max(times[0], 1e-9) > 50:
                return "exponential", times[-1], f"{ch!r}*30+{suffix!r}"
    return "linear", worst, ""

if __name__ == "__main__":
    for line in sys.stdin:
        pattern = line.rstrip("\n")
        if not pattern:
            continue
        try:
            verdict, worst, witness = classify(pattern)
        except re.error as error:
            verdict, worst, witness = "invalid", 0.0, str(error)
        print(json.dumps({"pattern": pattern, "measured": verdict, "worst": worst, "witness": witness}))
