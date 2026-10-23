import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Redirect, Route, Switch } from "wouter";
import "./styles.css";
import { AdminDashboard } from "./admin/AdminDashboard";
import { AdminEmployees } from "./admin/AdminEmployees";
import { AdminSettings } from "./admin/AdminSettings";
import { AdminSignIn } from "./admin/AdminSignIn";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";
import { SignIn } from "./pages/SignIn";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/signin" component={SignIn} />
      <Route path="/app" component={Dashboard} />
      <Route path="/admin/signin" component={AdminSignIn} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/admin/discounts" component={AdminSettings} />
      <Route path="/admin/employees" component={AdminEmployees} />
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  </StrictMode>,
);
