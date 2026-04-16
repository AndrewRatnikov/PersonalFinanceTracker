# PRD: Analytics Dashboard Enhancement

## Problem Statement

The current analytics dashboard in MinimaSpend is limited to basic category breakdowns and chronological spending bars. Users lack a holistic view of their financial health, specifically regarding income flow, budget adherence, and net worth trends over time.

## Solution

Enhance the Analytics page with advanced visualizations that provide deeper insights into cash flow, budget performance, and long-term wealth accumulation. This involves introducing new chart types (Line, Area, Sankey, and Advanced Bar charts) and the necessary data infrastructure to support them.

## User Stories

1. As a user, I want to see my income and expenses tracked on a single line chart with **AI-predicted spend lines**, so that I can anticipate future cash flow needs.
2. As a user, I want to see a Budget vs. Actual bar chart with interactive elements, so that I can zoom into specific category variances.
3. As a user, I want to see an Area chart of my net worth growth with **AI-embedded forecasting**, so that I can project my financial future based on current trends.
4. As a user, I want to see a Sankey diagram showing the flow from income sources to expense sinks, so that I can discover hidden "leaks" in my cash flow.
5. As a user, I want my donut chart slices to be dynamically updated via **AI auto-categorization**, ensuring my spending reports are always accurate without manual tagging.

## Implementation Decisions

### Modules & Data Model Changes
- **Income Tracking**: Add an `income` table to store earnings, bonuses, and side-hustle sources.
- **Budgeting System**: Add a `budgets` table to define monthly limits per category and track "envelope-style" allocations.
- **Net Worth Engine**: Implement a background job or server-side logic to calculate cumulative net worth (Assets - Liabilities) over time.
- **AI Forecasting Module**: Integrate an LLM or statistical model to generate "Predicted Spend" and "Net Worth Forecasting" data points.
- **Visualization Components**:
    - `TrendingLineChart.tsx`: Line chart with historical data and a "dashed" prediction line.
    - `BudgetVarianceBarChart.tsx`: Side-by-side comparison of Budget vs. Actual.
    - `ForecastingAreaChart.tsx`: Layered area chart showing growth with future projections.
    - `CashFlowSankey.tsx`: Visual flow diagram from income sources to expense categories.

### Architectural Decisions
- Use TanStack Router search parameters to maintain date range synchronization across all charts.
- Implement server-side aggregation for complex charts (Sankey, Net Worth) to keep the client light.

## Testing Decisions
- **Unit Tests**: Test the aggregation logic in `analytics.ts` to ensure totals match across different time ranges.
- **Visual Testing**: Verify chart responsiveness and tooltip accuracy.

## Out of Scope
- Real-time bank synchronization (manual entry or CSV only for now).
- Multi-currency conversion for Sankey (will use the primary currency).

## Further Notes
- AI categorization could be implemented as a server function that runs on expense creation/update.
