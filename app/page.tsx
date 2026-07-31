import CompilerSmokeTest from "@/app/components/compiler-smoke-test";
import ManuscriptWorkspace from "@/app/components/manuscript-workspace";

export default function Home() {
  return (
    <>
      <ManuscriptWorkspace />
      {process.env.NODE_ENV !== "production" && <CompilerSmokeTest />}
    </>
  );
}
