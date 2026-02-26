# Dependency Flowchart

This flowchart visualizes the internal dependencies within the `src` directory of the MinimaSpend application.

```mermaid
graph TD
    subgraph Root
        router["router.tsx"]
        routeTree["routeTree.gen.ts"]
    end

    subgraph Routes
        rootRoute["routes/__root.tsx"]
        indexRoute["routes/index.tsx"]
        loginRoute["routes/login.tsx"]
        authCallbackRoute["routes/auth.callback.tsx"]
    end

    subgraph Components
        header["Header.tsx"]
        stats["DashboardStats.tsx"]
        form["SpeedEntryForm.tsx"]
        history["RecentHistoryList.tsx"]
    end

    subgraph Library
        analytics["lib/analytics.ts"]
        auth["lib/auth.ts"]
        authCtx["lib/authContext.ts"]
        cats["lib/categories.ts"]
        expenses["lib/expenses.ts"]
        serverClient["lib/serverClient.ts"]
        supabase["lib/supabase.ts"]
        domain["lib/domain.ts"]
        dbAgg["lib/database.ts"]
    end

    styles["styles.css"]

    %% Root Dependencies
    router --> routeTree
    router --> authCtx
    routeTree --> rootRoute
    routeTree --> indexRoute
    routeTree --> loginRoute
    routeTree --> authCallbackRoute
    routeTree --> router

    %% Route Dependencies
    rootRoute --> auth
    rootRoute --> authCtx
    rootRoute --> header
    rootRoute --> styles

    indexRoute --> analytics
    indexRoute --> cats
    indexRoute --> expenses
    indexRoute --> stats
    indexRoute --> form
    indexRoute --> history

    loginRoute --> supabase
    authCallbackRoute --> auth

    %% Component Dependencies
    header --> router
    stats --> domain
    form --> domain
    history --> domain

    %% Library Dependencies
    analytics --> domain
    analytics --> serverClient
    cats --> domain
    cats --> serverClient
    expenses --> domain
    expenses --> serverClient
    auth --> supabase
    serverClient --> supabase
    dbAgg --> analytics
    dbAgg --> cats
    dbAgg --> expenses
    dbAgg --> serverClient

    %% Styling
    classDef route fill:#f9f,stroke:#333,stroke-width:2px;
    classDef library fill:#bbf,stroke:#333,stroke-width:1px;
    classDef component fill:#dfd,stroke:#333,stroke-width:1px;
    classDef root fill:#ffd,stroke:#333,stroke-width:2px;

    class indexRoute,loginRoute,authCallbackRoute,rootRoute route;
    class analytics,auth,authCtx,cats,expenses,serverClient,supabase,domain,dbAgg library;
    class header,stats,form,history component;
    class router,routeTree root;
```

## Key Observations

1.  **Core Domain**: `lib/domain.ts` is the foundational layer, providing types for almost all other parts of the system.
2.  **Supabase Orchestration**: `lib/supabase.ts` and `lib/serverClient.ts` handle the connection to the backend, with `serverClient` being used by domain-specific library functions.
3.  **Route Integration**: The routes in `src/routes` act as the main integration point, combining UI components with library logic.
4.  **TanStack Router**: The application uses TanStack Router with a generated `routeTree`, which creates a central hub for navigation and routing logic.
