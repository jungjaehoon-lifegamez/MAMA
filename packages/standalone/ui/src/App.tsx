import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Board from './pages/Board';
import Triggers from './pages/Triggers';
import Tasks from './pages/Tasks';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Board />} />
        <Route path="triggers" element={<Triggers />} />
        <Route path="tasks" element={<Tasks />} />
      </Route>
    </Routes>
  );
}
