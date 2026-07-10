import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route
        index
        element={<div className="p-4 text-text">MAMA Operator -- walking skeleton</div>}
      />
    </Routes>
  );
}
