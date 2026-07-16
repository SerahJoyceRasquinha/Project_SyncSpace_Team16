# SyncSpace

A modern real-time collaborative whiteboard application that enables multiple users to draw, brainstorm, design, and collaborate simultaneously within secure workspaces.

SyncSpace combines a responsive canvas, live synchronization, authentication, workspace management, and collaborative editing into a single web application suitable for team discussions, flowcharts, diagrams, wireframes, and visual brainstorming.

---

# Features

## Real-Time Collaboration

- Multi-user collaborative whiteboard
- Live synchronization across connected clients
- CRDT-based conflict resolution
- Instant updates without page refresh
- Shared editing experience

---

## Workspace Management

- Create collaborative workspaces
- Join existing workspaces
- Secure workspace access
- Admin-controlled workspace management
- Persistent workspace data

---

## Authentication

- User registration
- Secure login
- Protected routes
- Session management
- Authorization middleware

---

## Drawing Tools

- Select Tool
- Freehand Pencil
- Rectangle
- Circle
- Ellipse
- Triangle
- Diamond
- Star
- Hexagon
- Text Tool
- Eraser

---

## Text Editing

- Click-and-drag text box creation
- Resizable text regions
- Multi-line editing
- Automatic word wrapping
- Dynamic text box expansion
- Double-click to edit existing text
- Keyboard shortcuts for committing text

---

## Shape Editing

- Drag and reposition objects
- Resize shapes
- Rotate supported shapes
- Selection handles
- Accurate positioning
- Smooth transformations

---

## Canvas Features

- Infinite drawing experience
- Object selection
- Layered rendering
- Shape transformations
- Smooth interactions
- Responsive canvas

---

## Backend Features

- REST API
- Workspace management APIs
- Authentication APIs
- Database integration
- Persistent document storage
- Middleware-based security

---

# Tech Stack

## Frontend

- React
- React Konva
- JavaScript
- HTML5
- CSS3
- Vite

## Backend

- Node.js
- Express.js
- MongoDB
- Mongoose

## Collaboration

- CRDT Synchronization
- Real-time document updates

---

# Project Structure

```
SyncSpace
│
├── frontend
│   ├── Components
│   ├── Canvas
│   ├── Authentication
│   ├── Workspace
│   └── Drawing Tools
│
├── backend
│   ├── Controllers
│   ├── Models
│   ├── Middleware
│   ├── Routes
│   ├── Config
│   └── Database
│
└── package.json
```

---

# Installation

Clone the repository

```bash
git clone <repository-url>
```

Install all dependencies

```bash
npm install
npm install --prefix frontend
npm install --prefix backend
```

---

# Run the Project

Start both frontend and backend

```bash
npm run dev
```

Or start individually

Frontend

```bash
cd frontend
npm run dev
```

Backend

```bash
cd backend
npm run dev
```

---

# Main Functionalities

- Create collaborative workspaces
- Join shared workspaces
- Draw using multiple tools
- Add and edit text
- Create diagrams
- Resize and move shapes
- Real-time synchronization
- Persistent workspace storage
- Secure authentication

---

# Recent Improvements

- Redesigned text tool with drag-to-create text regions
- Multi-line editable text boxes
- Automatic word wrapping
- Dynamic text box resizing
- Improved editing workflow
- Fixed circle positioning
- Fixed star positioning
- Accurate drag behavior for centered shapes
- Improved transformation handling
- Codebase cleanup
- Enhanced drawing stability

---

# Future Enhancements

- Undo / Redo history
- Export as PNG
- Export as PDF
- Zoom and Pan
- Sticky Notes
- Flowchart connectors
- Curved connectors
- Collaboration cursors
- Version history
- Comments
- File uploads
- Image support
- Presentation mode

---

# Contributors

Developed as a collaborative real-time whiteboard application using React, Node.js, Express, MongoDB, and CRDT-based synchronization.

---

# License

This project is intended for educational and collaborative development purposes.