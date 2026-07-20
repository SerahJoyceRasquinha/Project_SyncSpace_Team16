## Prerequisites

Before running the project, ensure you have the following installed:

- **Node.js** (v18 or later recommended)
- **npm** (included with Node.js)
- **Git**
- **MongoDB** *(Optional)*

> **Note:** MongoDB is optional. If `MONGO_URI` is left blank in `backend/.env`, the application will run entirely in memory. All features will work normally, but data will be lost whenever the server is restarted.

---

## Installation (or directly go to running the project, which also installs everything automatically)

Install all required dependencies by running:

```bash
npm install --prefix backend
npm install --prefix frontend
npm install
```

Next, create or update the following file:

**backend/.env**

```env
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
JWT_SECRET=change-me-to-a-long-random-string
MONGO_URI=
```

- Leave `MONGO_URI` blank to use the in-memory datastore.
- Provide a MongoDB connection string if you want workspaces and snapshots to persist after server restarts.

---

## Running the Project

After installing all dependencies and configuring the environment, start the application using the provided development script.

### Option 1 (Recommended)

Simply **double-click**:

```text
dev.bat
```

### Option 2 (PowerShell / Windows Terminal)

Run:

```powershell
.\dev.bat
```

The script automatically starts both the backend and frontend development servers.

Once both servers have started successfully, open:

**http://localhost:5173**

in your browser.


I want you to thoroughly analyze this entire project from beginning to end before making any modifications. Understand the complete architecture, frontend structure, backend APIs, state management, whiteboard implementation, collaboration logic, drawing engine, synchronization mechanism, tool system, toolbar implementation, property panels, reusable components, event handling, and styling.

Do not rewrite existing functionality unnecessarily. Preserve all existing features including real-time collaboration, synchronization, workspace management, permissions, whiteboard objects, shapes, connectors, arrows, text, code editor, zooming, panning, selection, undo/redo, saving, loading, and all current interactions. These updates should integrate naturally into the existing architecture.

The following updates are required.

The first major improvement is the drawing tools.

Currently, whenever the Pencil or Brush tool is selected, drawing is only possible using the default red color. This limitation should be completely removed.

The Pencil and Brush tools should become fully customizable, similar to professional drawing applications.

When either tool is selected, the user should be able to choose any drawing color.

The color picker should support:

• Full RGB color selection
• HEX color input
• Opacity/Alpha adjustment
• Recently used colors
• Basic preset colors for quick access

The selected color should immediately become the active drawing color.

In addition to color selection, provide adjustable brush thickness.

The user should be able to increase or decrease stroke width smoothly using either a slider or numeric control.

Support a wide range of sizes, from extremely thin lines for writing to thick marker-like strokes.

The application should remember the previously selected thickness while the tool remains active.

Next, introduce multiple brush styles.

Instead of a single drawing style, users should be able to choose between different brush types such as:

• Normal Pen
• Pencil
• Marker
• Highlighter (semi-transparent)
• Calligraphy brush
• Soft brush
• Dashed stroke
• Dotted stroke

The implementation should be designed in a modular way so additional brush styles can easily be added in future versions.

Brush previews should be visible before selection so users understand how each brush behaves.

Switching between brush styles should not interrupt the current drawing session.

All drawing properties should synchronize correctly across connected collaborators so every participant sees identical strokes.

Previously drawn objects should retain the properties they were created with.

Changing the current brush settings should only affect newly created strokes.

The second major improvement is redesigning the tool property interface.

Currently, whenever a tool is selected, the properties panel opens on the right side of the drawing board.

This creates several usability issues.

It reduces the available drawing space.

It overlaps the whiteboard.

It obstructs content that users are actively working on.

This behavior should be completely redesigned.

Instead of opening a floating panel on the right, introduce a dedicated horizontal Tool Properties Bar.

The new layout should consist of:

Top Toolbar

↓

Tool Properties Toolbar

↓

Drawing Canvas

The Tool Properties Toolbar should always appear directly below the main toolbar and directly above the whiteboard canvas.

This secondary toolbar should dynamically change depending on the selected tool.

For example:

If Pencil is selected:

Display

• Color picker
• Thickness
• Brush type
• Opacity

If Rectangle is selected:

Display

• Fill color
• Border color
• Border thickness
• Corner radius (if applicable)
• Opacity

If Circle is selected:

Display

• Fill
• Stroke
• Stroke width
• Opacity

If Arrow is selected:

Display

• Line color
• Thickness
• Arrow style
• Arrow head type
• Dashed option

If Connector is selected:

Display

• Connector type
• Color
• Thickness
• Routing style
• Curve amount

If Text is selected:

Display

• Font
• Font size
• Bold
• Italic
• Underline
• Text color
• Alignment

Every tool should expose only the controls relevant to that tool.

There should never be unnecessary controls visible.

The toolbar should update instantly when switching between tools.

The height of this toolbar should remain fixed to avoid layout shifts.

The toolbar should be responsive across different screen sizes.

On smaller displays, controls may wrap or become scrollable horizontally.

The drawing canvas should automatically resize so no content is hidden.

Nothing should overlap the canvas anymore.

The properties toolbar should remain visible while working so users can quickly change settings without opening popup panels.

Avoid modal dialogs wherever possible.

The overall appearance should feel similar to professional whiteboard applications like Figma, Excalidraw, Miro, FigJam, Canva Whiteboard, or Microsoft Whiteboard.

The third major improvement is introducing a comprehensive Help system.

Add a new toolbar option called "Help Me".

This should be accessible at all times from the main toolbar.

Clicking Help Me should open a clean help window, dialog, or side panel.

The goal is to allow first-time users to understand every feature without needing external documentation.

The Help section should include clear explanations for every available tool.

Examples include:

Selection Tool

Explain selecting objects, moving them, resizing them, rotating them, multi-selection, and deselecting.

Pencil Tool

Explain freehand drawing, brush customization, colors, thickness, and brush styles.

Brush Tool

Explain artistic drawing features and brush customization.

Text Tool

Explain creating text boxes, editing text, resizing, formatting, and changing fonts.

Rectangle Tool

Explain drawing, resizing, fill color, stroke color, and editing.

Circle Tool

Explain drawing circles and ellipses.

Line Tool

Explain creating straight lines.

Arrow Tool

Explain the different arrow styles and arrow heads.

Connector Tool

Explain connecting shapes, bend points, curved connectors, and automatic routing.

Shape Tools

Explain editing, resizing, duplication, deletion, and grouping.

Zoom Controls

Explain:

• Mouse wheel zoom
• Trackpad gestures
• Zoom buttons
• Keyboard shortcuts
• Reset zoom

Canvas Navigation

Explain:

• Panning
• Moving around the infinite canvas
• Fit to screen
• Center canvas
• Reset view

Collaboration

Explain:

• Multiple users
• Live updates
• Real-time cursors
• Shared editing
• Conflict-free collaboration

Workspace Features

Explain:

• Creating workspaces
• Joining workspaces
• Permission requests
• Admin approval
• Secret codes
• Workspace policies

History Features

Explain:

• Undo
• Redo
• Restore changes

Saving

Explain how workspaces are saved automatically and synchronized.

Code Editor

Explain:

• Selecting programming languages
• Running programs
• Viewing output
• Collaboration inside the editor

Keyboard Shortcuts

Create a dedicated section listing all available shortcuts.

Examples include:

Undo

Redo

Copy

Paste

Delete

Duplicate

Zoom In

Zoom Out

Reset Zoom

Select All

Group

Ungroup

The Help page should also include frequently asked questions such as:

How do I move around the canvas?

How do I zoom?

How do I change colors?

How do I edit shapes?

How do I resize objects?

How do I delete objects?

How do I connect shapes?

How do I invite collaborators?

How do I request access?

How do I change workspace permissions?

Include small icons or illustrations wherever appropriate to make the documentation easier to understand.

The Help interface should be searchable.

Users should be able to type keywords like "zoom", "arrow", "text", or "brush" and instantly navigate to the relevant section.

The Help system should be future-proof so additional documentation can easily be added later.

General Requirements

Maintain complete compatibility with the existing project architecture.

Do not break any existing whiteboard functionality.

Ensure all new UI components are responsive across desktop and laptop screen sizes.

Maintain consistent spacing, typography, colors, animations, and styling throughout the application.

Ensure all newly added controls synchronize correctly in collaborative sessions where applicable.

Avoid duplicate code by creating reusable components for property controls.

The application should remain performant even with many whiteboard objects.

The overall user experience should feel polished, intuitive, modern, and comparable to professional collaborative whiteboard applications.